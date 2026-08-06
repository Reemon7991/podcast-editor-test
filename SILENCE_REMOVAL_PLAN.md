# Per-clip silence removal — design plan

**Status: accepted, not yet implemented.** Saved here so a future session can
pick this up without re-deriving it — same discipline `CLAUDE.md` already
applies to `PERSISTENCE_UNDO_ORIGINAL_PLAN.md`/`TTS_CARTESIA_PLAN.md`. See
`CLAUDE.md`'s "Planned features" list (AI features) for the current pointer
to this file. Everything below was worked out by reading this app's and
`@waveform-playlist/*`'s actual source (not assumed) — file/line references
throughout are worth re-confirming at implementation time in case the
vendored library has moved on since this was written, same caveat every
other plan doc in this repo already carries.

## Decisions confirmed (don't re-litigate these)

- **Detection: energy/RMS-based, fully client-side.** No VAD/ML model — this
  is a standard DSP technique, matches what every comparable tool (Audacity's
  Truncate Silence, Adobe Podcast, Auphonic, `ffmpeg silencedetect`) actually
  uses for this exact feature, and needs no new dependency or server round
  trip. `CLAUDE.md`'s current "almost certainly needs server-side processing"
  note for this feature was written before this was worked out — wrong for
  silence removal specifically (still plausibly true for noise/hum removal,
  untouched by this plan).
- **Scope: per-clip**, triggered from a single clip's own action menu — not a
  whole-track or whole-project batch operation for v1.
- **Output shape: one continuous, connected clip** — not gaps left in place
  (`carveClipRange`) and not many small clips packed edge-to-edge. The kept
  (non-silent) audio is spliced into a single new buffer, and the edited clip
  is replaced by exactly one new clip referencing it. This was the deciding
  factor that ruled out `@waveform-playlist/core`'s `carveClipRange` and
  `@waveform-playlist/engine`'s `splitClip` as the mechanical primitive
  (earlier exploration in this planning conversation considered them,
  before "one connected clip" was locked in) — both operate at the
  timeline/`ClipMeta` level and would produce multiple adjacent clips, which
  is a different, worse-at-scale result (see "Why not `carveClipRange`"
  below). The real mechanism is a raw-sample splice, closer in shape to
  `useGenerateSpeech.ts`'s "new asset → new clip" pipeline than to
  `useClipActions.ts`'s clip-rearrangement pipeline.
- **The edited clip does not move or resize anything else on the
  timeline.** It keeps its own `startSample`; it just becomes shorter
  (ends earlier) once internal silence is excised. Nothing downstream
  ripples to close the resulting gap, and no other track is touched. This
  is a deliberate v1 scope cut, not an oversight — ripple-closing the
  timeline (and whether that should apply across tracks, to keep multi-track
  sync) is a materially bigger feature with its own open design questions;
  bundling it into "remove silence from this one clip" would surprise a user
  who just wanted the clip itself tightened. Worth revisiting explicitly
  later, not silently expanding scope now.
- **Commit exactly once, at the end.** This is a hard requirement, not a
  style preference — see "Performance: rebuild count" below for why looping
  `commit()` per detected silence region would be actively harmful at this
  app's target scale (2-3 hour podcasts).
- **Undo/redo need zero new store code.** Routing the final result through
  the existing `commit()` gives one undo step for free, identical to
  duplicate/delete/fade/generate-speech — confirmed by reading
  `store/projectStore.ts` directly (see "Undo/redo" below for the trace).

## How this plugs into the existing app

Closest existing precedent is `useGenerateSpeech.ts`, not `useClipActions.ts`:
this feature also produces **new decoded audio** that needs a new
content-hash `assetId`, in-memory registration, and IndexedDB persistence —
not just a rearrangement of existing `ClipMeta` fields. The pipeline:

```
clip's existing AudioBuffer
  → detectKeepRanges()          (pure, new — windowed RMS over the clip's own [offsetSamples, offsetSamples+durationSamples) window)
  → splice kept ranges together  (pure, new — one new AudioBuffer)
  → encode to WAV bytes          (pure, new — no standalone encoder is exported by the library, see below)
  → hashFileBytes()               (existing, assetRegistry.ts)
  → registerAsset()                (existing, assetRegistry.ts)
  → saveAsset()                     (existing, persistence.ts — failure logged+swallowed, same as every other asset save)
  → build replacement ClipMeta       (new, small — see "Fade carry-over" below for the one non-obvious field rule)
  → commit(update, "Remove silence")  (existing, store/projectStore.ts — exactly once)
```

Every step after "encode to WAV bytes" reuses an existing app primitive
unchanged. Only the detection + splice + encode steps are genuinely new code.

## Why not `carveClipRange`

Worth writing down explicitly since an earlier pass through this same
planning conversation identified `@waveform-playlist/core`'s
`carveClipRange(clips, rangeStart, rangeEnd)` as the closest existing
primitive, before "stay as one connected audio" was confirmed as the actual
requirement. `carveClipRange` is real, pure, and does operate correctly on
`ClipMeta[]` (confirmed by reading `core/dist/index.js` — it's plain
object-spread, never dereferences `audioBuffer`), but it **removes a range
and leaves a gap** — it does not produce one continuous buffer. Using it (or
`splitClip`, its sibling) would mean one new `ClipMeta` per kept segment,
i.e. one clip per pause-free stretch of speech. For a real podcast with a
lot of dead air that's easily hundreds of resulting clips on one track, and
per `CLAUDE.md`'s own documented "Post-Phase-3 perf regression" section,
per-track clip count is exactly the thing that makes every *later* drag/trim
on that track more expensive (the `dehydrate()`/`hydrate()` per-frame cost
during a live drag scales with the track's own clip count) — plus N times
the DOM overlay cost (`ClipActionsOverlay.tsx` renders a name label + "..."
button per clip, unconditionally). Splicing into one buffer sidesteps all of
that: the track's clip count is unchanged by this operation (one clip in,
one shorter clip out), so it can't degrade future editing performance the
way the fragmented alternative would have. If a "leave gaps, keep clips
separate" mode is ever wanted as an alternative in the future,
`carveClipRange` is still the right tool for *that* — just not for what was
actually asked for here.

## Implementation

### 1. `src/utils/silenceDetection.ts` (new, pure — no React/DOM)

The one genuinely new algorithm in this feature. Confirmed via a grep across
all six vendored `@waveform-playlist/*` packages that nothing silence/RMS/
energy-detection-shaped already exists to reuse or duplicate (the library
does ship an RMS-capable AudioWorklet, `@waveform-playlist/worklets`'
`meterProcessorUrl` — but that's built for **live** metering during an
active playback/recording graph, streaming messages off the audio thread; it
is the wrong tool for one-shot offline analysis of an already-decoded
`AudioBuffer` already sitting in memory, which just needs a synchronous loop
over `Float32Array`s).

```ts
export interface SilenceDetectionOptions {
  windowSeconds?: number;          // default 0.02  (20ms analysis window — also the unit
                                    //                every step below operates in, not
                                    //                per-sample; see algorithm step 1)
  minSilenceSeconds?: number;      // default 0.4   (pause must be ≥ this long to count)
  paddingSeconds?: number;         // default 0.1   (kept on each side of every cut)
  minKeptSegmentSeconds?: number;  // default 0.1   (matches the engine's own unexported
                                    //                DEFAULT_MIN_DURATION_SECONDS=0.1 —
                                    //                see engine/dist/index.js:192; kept
                                    //                segments shorter than this are treated
                                    //                as spurious blips and merged into silence)
  noiseFloorPercentile?: number;   // default 0.1   (10th percentile of per-window RMS =
                                    //                noise floor estimate)
  thresholdMultiplier?: number;    // default 3     (linear; ≈ +9.5dB over the noise floor —
                                    //                20*log10(3) ≈ 9.54 — comment the dB
                                    //                equivalent in code, don't require a
                                    //                runtime dB conversion for v1, see below)
}

export interface KeepRange {
  /** Sample offsets relative to the analyzed window's own start (0 = the
   *  clip's offsetSamples), NOT relative to the timeline. */
  startSample: number;
  endSample: number;
}

/** Returns ascending, non-overlapping ranges to KEEP. A single range
 *  spanning [0, durationSamples) means "no silence detected" — treat as a
 *  no-op at the caller (see useRemoveSilence.ts below), don't commit a
 *  pointless identical-content clip. */
export function detectKeepRanges(
  channelData: Float32Array[],
  sampleRate: number,
  options?: SilenceDetectionOptions
): KeepRange[];
```

Algorithm, spelled out precisely since the naive version of each step is a
real trap:

1. **RMS per non-overlapping `windowSamples`-sized window, O(N) total —
   computed once per window, never per sample.** An earlier draft of this
   plan called for a *per-sample* running-sum RMS series (a trailing sum of
   squares updated per sample, `+= newSample²` / `-= sampleLeavingWindow²`,
   giving one RMS value per sample). That's still O(N) time, but the
   resulting series is sample-length — for a 3-hour clip at 44.1kHz, ~476M
   entries (~1.9GB as a `Float32Array`) — and step 3 below needs to *sort*
   that series to get a percentile. Sorting hundreds of millions of floats
   (while also keeping an unsorted copy alongside it for the hysteresis pass
   in step 4) is a multi-GB, likely tab-hanging operation — exactly the
   class of "cost scales with whole-clip/whole-session size" trap
   `CLAUDE.md`'s "Post-Phase-3 perf regression" section already went out of
   its way to eliminate elsewhere in this app (that section's `dehydrate()`
   fix is the same shape of bug, just a different call site). Windowing
   first avoids this: sum each window's squared samples once (no sample is
   ever revisited, so this is still a single O(N) pass — just accumulating
   into `totalSamples / windowSamples` buckets instead of `totalSamples`
   ones), producing one RMS value per window. This is also how every
   comparable tool (ffmpeg `silencedetect`, Audacity's Truncate Silence)
   actually does this, not a novel simplification. For the same 3-hour clip
   and the default 20ms window, that's ~540K entries — sorting it in step 3
   costs milliseconds, not a stress-test. Every later step (percentile,
   hysteresis run-length, padding) now operates in window units, converting
   back to sample offsets only at the very end when building `KeepRange`s.
   Boundary precision is therefore ±one window (~20ms at the default),
   inaudible given the mandatory `paddingSeconds` padding already applied on
   top (step 5).
2. **Combine channels by taking the max RMS across channels per window**,
   not an average and not channel 0 only — content panned hard to one
   channel shouldn't be misclassified as silence because the other channel
   is quiet.
3. **Threshold in linear amplitude space, not dB**, for v1 — skip the
   `gainToDb`/`dBToNormalized` round-trip entirely (those live in
   `@waveform-playlist/core`, not currently an app dependency — see the
   dependency note below) since the comparison itself never needs to leave
   linear space. Estimate the noise floor as the `noiseFloorPercentile`-th
   percentile of the per-window RMS series (sorted — cheap now that the
   series is window-sized, not sample-sized, per step 1), multiply by
   `thresholdMultiplier` to get the actual cutoff. **Do not hardcode one
   fixed threshold** — a fixed dB/amplitude value is the single biggest
   practical failure mode of naive silence-removal tools (works for one
   mic/room, over- or under-trims for every other one); deriving it from
   each clip's own quiet-percentile is still simple and deterministic, just
   self-calibrating per recording.
4. **Hysteresis via `minSilenceSeconds`, not a second threshold.** Find
   contiguous below-threshold runs of *windows*; only runs whose total
   duration (`runLengthWindows * windowSeconds`) is at least
   `minSilenceSeconds` count as real silence. This avoids the chattering a
   single fixed threshold produces at every quiet phoneme boundary or
   breath.
5. **Padding**: convert each silence run's window-index boundaries to
   sample offsets (`windowIndex * windowSamples`), then pull them inward by
   `paddingSeconds` before cutting (i.e. the *kept* region extends
   `paddingSeconds` further into what was detected as silence on each side)
   — cutting exactly at the detected boundary clips word onsets and breaths,
   which every real tool doing this pads against.
6. **Merge tiny kept slivers**: a kept segment shorter than
   `minKeptSegmentSeconds` after padding (measured in samples, after the
   window→sample conversion in step 5) is almost certainly a spurious
   detection blip (e.g. a click between two real pauses), not real content —
   fold it into the surrounding silence rather than keeping a near-inaudible
   fragment.
7. **Whole-clip-is-silence guard**: if the resulting kept ranges sum to
   below `minKeptSegmentSeconds` total, this isn't a real edit — the caller
   should surface "No audio detected above the silence threshold" and abort,
   not commit a degenerate near-empty clip.

### 2. Splice + buffer construction

Reuse `@waveform-playlist/core`'s `concatenateAudioData`/`createAudioBuffer`
(confirmed by reading `core/dist/index.js:708-726` — both are plain
`TypedArray.set()` copies into a pre-sized buffer plus one
`audioContext.createBuffer()`/`copyToChannel()` call; no
`OfflineAudioContext` render pass involved, memory-bandwidth-bound and fast
even at multi-GB scale) rather than hand-rolling the same thing.

**This needs `@waveform-playlist/core` added as an explicit direct
dependency** (`package.json` — it's already resolved transitively in
`node_modules` today via `browser`/`engine`/`ui-components`, so this costs
nothing to install, just a manifest entry). This is a different call than
`clipGeometry.ts`'s `clipPixelWidth`, which deliberately reimplements
core's version locally instead of adding the dependency — that was
justified there because it's a single trivial arithmetic line; here we're
reusing real, tested buffer-construction logic, which is worth taking as a
real dependency for. Add a one-line note to `CLAUDE.md`'s "Critical setup
gotchas" if this lands, matching how every other new dependency in this repo
gets disclosed.

Per channel: slice out each `KeepRange` from the source channel's
`Float32Array` (`.slice()` copies), pass the resulting array of chunks to
`concatenateAudioData()`, then `createAudioBuffer(audioContext, channels,
sampleRate, channels.length)` once all channels are done. **The fourth
argument (`channelCount`) must be passed explicitly as `channels.length`,
never omitted** — confirmed by reading `core/dist/index.js:718`:
`createAudioBuffer`'s `channelCount` parameter defaults to `1` when not
supplied, and the function only copies `Math.min(channelCount,
channels.length)` channels into the created buffer. Omitting it on a stereo
clip wouldn't throw or warn — it would silently produce a 1-channel buffer
containing only the first channel's audio, a correctness bug with no error
signal at all.

### 3. `src/utils/wavEncode.ts` (new — small, hand-rolled)

No standalone "`AudioBuffer` → WAV bytes" function is exported anywhere in
`@waveform-playlist/browser` (checked `browser/dist/tone.d.ts`'s full export
list — WAV encoding exists only *internal* to `useExportWav`'s full mixdown
pipeline, which renders through an `OfflineAudioContext`/Tone graph; wrong
tool here since we already have final PCM sitting in a plain `AudioBuffer`
and would just be serializing it, not re-rendering it). A small
`encodeWavPcm16(buffer: AudioBuffer): Blob` (~30 lines: standard RIFF/WAVE
header + 16-bit PCM interleaved samples) is the right size for this — this
repo already has the mirror-image of this exact logic in
`e2e/fixtures.ts`'s `makeSineWavBuffer` (hand-writes a RIFF header for test
fixtures), so the format details are already proven-correct in this
codebase, just in the decode-test direction rather than encode-production.
Needed only to get bytes to hash (`hashFileBytes`, which takes an
`ArrayBuffer`) and a `Blob` to hand to `saveAsset` — matches the exact
pattern `useGenerateSpeech.ts` already uses for its Cartesia response.

### 4. `src/hooks/useRemoveSilence.ts` (new)

Mirrors `useGenerateSpeech.ts`'s shape closely — same
decode-or-compute-then-commit structure, same guards:

```ts
async function removeSilence(trackId: string, clip: AudioClip) {
  if (isProcessingRef.current) return;      // same synchronous-ref double-submit guard
  isProcessingRef.current = true;            // playPendingRef/isGeneratingRef already
  setProcessingClipId(clip.id);              // establish (state alone isn't enough — a
  try {                                      // second click can land before React
    const audioContext =                     // disables the menu item). Deliberately
      Tone.getContext().rawContext as AudioContext;  // APP-WIDE single-flight, not
                                              // per-clip — mirrors useGenerateSpeech.ts's
                                              // isGeneratingRef exactly (one generation
                                              // in flight at a time). See "UI" below for
                                              // why the disabled state must match this
                                              // scope, not just the matching clip.

    const result = spliceOutSilence(          // wraps detectKeepRanges + the splice
      audioContext,                            // step above
      clip.audioBuffer!,                       // already hydrated — ClipActionsOverlay.tsx
      clip.offsetSamples,                       // has the real AudioBuffer in scope at the
      clip.durationSamples,                      // call site via usePlaylistData().tracks,
      DEFAULT_OPTIONS                             // no assetRegistry lookup needed here
    );

    if (result === null) {                     // detectKeepRanges returned "whole clip kept"
      setMessage("No silence detected in this clip.");
      return;                                    // no commit — don't pollute undo history
    }                                              // or IndexedDB with a no-op

    const wavBlob = encodeWavPcm16(result.buffer);
    const arrayBuffer = await wavBlob.arrayBuffer();
    const assetId = await hashFileBytes(arrayBuffer);
    registerAsset(result.buffer, assetId);
    saveAsset(assetId, wavBlob).catch((err) => {
      console.error("[podcast-editor] Failed to persist silence-trimmed clip", err);
      setSaveWarning(/* same non-fatal, surfaced pattern addFilesToTrack already uses */);
    });

    const newClip: ClipMeta = {
      id: crypto.randomUUID(),
      assetId,
      startSample: clip.startSample,          // clip does NOT move on the timeline
      durationSamples: result.buffer.length,
      offsetSamples: 0,
      sampleRate: result.buffer.sampleRate,
      sourceDurationSamples: result.buffer.length,
      gain: clip.gain,
      name: clip.name ? `${clip.name} (silence removed)` : undefined,
      color: clip.color,
      fadeIn: result.leadingEdgeKept ? clip.fadeIn : undefined,   // see "Fade carry-over" below
      fadeOut: result.trailingEdgeKept ? clip.fadeOut : undefined,
    };

    // Re-check the target still exists immediately before committing. This
    // pipeline (RMS scan + splice + encode + hash) can run for a genuinely
    // long moment on a large clip — a much bigger race window than any other
    // commit() caller in this app has (useGenerateSpeech.ts's only race is
    // network latency, and it always *inserts* a new clip rather than
    // replacing one, so it has no "target vanished" case at all). Read fresh
    // via getState() rather than a value closed over at call time — same
    // reasoning commit()'s own "Stale-closure rule" doc comment
    // (store/projectStore.ts) already gives for reading `present` at commit
    // time, not capture time. This matters because plain commit() — unlike
    // commitEngineOutput() — has no deepEqual no-op check: committing
    // against a track/clip that's already gone would silently push a no-op
    // "Remove silence" entry onto undo history instead of failing loudly
    // (useClipActions.ts's `if (!clip) return track;` is the same concern,
    // but that hook is synchronous, so it has no real race window to guard).
    const liveTrack = useProjectStore.getState().present.find((t) => t.id === trackId);
    if (!liveTrack || !liveTrack.clips.some((c) => c.id === clip.id)) {
      setMessage("This clip no longer exists — silence removal was discarded.");
      return; // no commit
    }

    commit(
      (prev) => prev.map((track) =>
        track.id === trackId
          ? { ...track, clips: track.clips.map((c) => (c.id === clip.id ? newClip : c)) }
          : track
      ),
      "Remove silence"
    );
  } finally {
    isProcessingRef.current = false;
    setProcessingClipId(null);
  }
}
```

`MIDI` clips (`clip.midiNotes` set) should refuse/no-op — this feature is
audio-only; the menu action shouldn't even appear for a MIDI clip.

**Fade carry-over rule** (the one non-obvious field on the replacement
clip): `spliceOutSilence`'s result should report whether the very first/last
kept sample corresponds to the *original* clip's start/end (i.e. no leading/
trailing silence was actually trimmed on that side). If the leading edge was
untouched, the original `fadeIn` still means the same thing against the new
buffer's start and carries over unchanged; if leading silence *was* trimmed
away, the old `fadeIn`'s timing no longer corresponds to anything real and
should be dropped. Symmetric for `fadeOut`/the trailing edge.

### 5. UI: `src/components/clip-menu/ClipActionsOverlay.tsx`

Add a fourth action to the existing per-clip "..." menu's `buildActions()`
array (alongside split/duplicate/delete, `ClipActionsMenu.tsx`'s existing
shape — no new menu component needed):

```ts
{
  id: "remove-silence",
  label: "Remove silence",
  onSelect: () => {
    onRemoveSilence(track.id, clip);
    closeAndReset();
  },
},
```

No confirmation dialog for v1 — consistent with duplicate/delete (neither
confirms), and it's undo-able within the session like everything else. A
busy indicator is needed since this is genuinely async and can take a
non-trivial moment on a long clip: track a `processingClipId` (mirrors
`menuOpenFor`'s shape) — `null` when idle, the clip's id while one is in
flight. Two different things read it, deliberately different in scope from
each other:

- The "Remove silence" action's own `disabled` field (`ClipMenuAction`
  already supports this, no `ClipActionsMenu.tsx` change needed) is
  `processingClipId !== null` on **every** clip's menu, not just the
  matching one. This has to match `useRemoveSilence.ts`'s `isProcessingRef`
  guard, which is app-wide single-flight (mirrors `useGenerateSpeech.ts`'s
  `isGeneratingRef` exactly — one removal in flight at a time, not one per
  clip). Disabling only the matching clip's item while leaving every other
  clip's "Remove silence" clickable would let a second click silently no-op
  against the ref guard with zero feedback — a real papercut, caught by
  cross-checking the ref's actual scope against the UI's.
- The busy *indicator* itself (spinner/label) still targets
  `processingClipId === clip.id` specifically, so only the one clip actually
  being processed reads as busy — every other clip's "Remove silence" item
  is simply grayed out, not spinning.

This is narrower than `isExporting`, which blocks the whole transport bar
(a real correctness requirement — an offline render temporarily swaps Tone's
global context, see "Export" in `CLAUDE.md`) — nothing here needs to block
unrelated editing (duplicate/delete/drag on other clips, playback, etc.),
only a re-entrant "Remove silence" click while one is already running. Exact
spinner/label placement is a UI-polish detail to settle at implementation
time, not something to over-specify here.

## Performance: rebuild count

**Hard requirement, not a nice-to-have**: the entire detect → splice →
encode → hash → persist sequence above must run as plain async JS with zero
store interaction, and call `commit()` exactly once at the very end. Traced
directly through `store/projectStore.ts`/`TimelineStage.tsx`/
`clipHydration.ts` earlier in this planning conversation: one `commit()`
call is one Zustand `set()`, which is one React render, which produces one
new `hydrate()`-derived `tracks` array reference, which triggers exactly one
full engine rebuild (the array is never `=== engineTracksRef.current`,
the provider's only rebuild-skip condition besides mid-drag). This matches
duplicate/delete/fade/generate-speech exactly.

The trap this guards against: looping over detected silence regions and
calling `commit()` once per region (a very natural-looking mistake for this
specific feature, more so than for any other mutation in this app) would
mean N separate rebuilds for N silence gaps — each one proportional to the
whole session's size per `CLAUDE.md`'s already-documented Post-Phase-3
rebuild-cost finding. A podcast with a lot of dead air could easily have
hundreds of gaps; that's the difference between one rebuild and hundreds.

Main-thread blocking risk (separate from rebuild count): a synchronous RMS
scan + splice over a multi-hour clip's buffer could jank the UI thread for a
noticeable moment. Not fixed in v1 — disclosed as deferred, same as this
app's other known-but-accepted at-scale risks (export's ~2GB Blob, unstress-
tested playback memory). If it turns out to matter in practice, chunk the
scan/splice loop with periodic yields (`setTimeout(0)`/`requestIdleCallback`)
or move it to a Web Worker — either is additive, doesn't change anything
else in this plan.

## Undo/redo

Traced directly through `store/projectStore.ts`'s actual `commit`/`undo`/
`redo` implementations (not assumed) earlier in this planning conversation:

- Undoing restores the track list containing the **old** clip (old
  `assetId`). `assetRegistry`'s module-level `Map` never evicts anything, so
  the old buffer is still resolvable the instant undo runs — no re-decode,
  playback works immediately.
- Redoing restores the **new** spliced clip the same way — its buffer is
  still resident from when the operation registered it.
- History entries store `TrackMeta[]` (no `audioBuffer`), so push/pop cost
  is unaffected by how large the spliced audio is.
- **Undo history is not persisted** (Phase 3 only saves `present`) — reload
  the page after removing silence and it's no longer undoable, same rule as
  every other edit. This lands harder here than for a fade tweak, though:
  the original untrimmed asset's bytes are still sitting in IndexedDB
  (nothing deletes them — no asset GC exists, already a disclosed
  limitation) but orphaned, with no "restore from asset library" UI to get
  back to them. Worth being explicit about this in whatever UI copy/help
  text ships with this feature, rather than letting a user discover it the
  hard way. Not something this plan fixes — flagged as a real, inherited
  consequence, same as `CLAUDE.md`'s existing "Known limitations" entries.
- `HISTORY_LIMIT = 100` (pre-existing, applies here like everywhere else):
  a silence-removal entry can roll off `past` after 100 later commits in the
  same session, same as any other edit.

## Not built (v1 scope, disclosed up front)

- Configurable threshold/min-duration/padding UI — v1 ships with the tuned
  defaults above; a settings surface (e.g. a small popover with a threshold
  slider) is a natural v2, not required to ship value first.
- Ripple/gap-closing across the rest of the timeline (see "Decisions
  confirmed" above) — the edited clip only gets shorter in place.
- Whole-track or whole-project batch mode — per-clip only.
- A "leave gaps, keep clips separate" alternative mode (`carveClipRange`
  would be the right primitive if this is ever wanted).
- Worker/chunked processing for very long clips — flagged as a deferred risk
  above, not solved here.

## Verification

- `tsc --noEmit` and `eslint` clean (existing repo bar).
- Manual pass against `npm run build && npm run start` (prod build — this
  project's established testing discipline): a clip with real silence gaps
  shrinks correctly and sounds continuous, undo restores the original in one
  step and it's immediately playable, a reload after the edit still has the
  spliced clip and it still plays, a clip with no silence shows the "no
  silence detected" message and creates no undo entry.
- New committed test, `e2e/silenceRemoval.spec.ts`, following this repo's
  existing Playwright conventions (`e2e/helpers.ts`, `data-testid`
  selectors, synthetic fixtures — extend `e2e/fixtures.ts` with a generator
  for a "tone / silence / tone / silence / tone" synthetic WAV with known
  gap positions, rather than depending on real audio). Cover: the resulting
  clip's duration matches the expected kept-audio total; a single `commit()`
  fires (assert via the same rebuild-counting approach
  `e2e/hydration.spec.ts` already uses for its rebuild-vs-no-rebuild
  assertions — here, exactly one rebuild, not zero); undo restores the
  original clip and audio in one step; a silence-free clip is a no-op (no
  new history entry, `canUndo` unchanged); the clip's own menu disables
  while processing and re-enables after; persistence round-trip (reload
  after the edit still has the spliced clip, still plays).
