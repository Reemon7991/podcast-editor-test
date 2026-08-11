# Transcription pipeline → Audio search → Filler-word removal

Original design doc for these three features (transcription is the shared
prerequisite for both search and filler-word removal) — kept corrected
against what actually ships, same discipline as `SILENCE_REMOVAL_PLAN.md`/
`TTS_CARTESIA_PLAN.md`/`PERSISTENCE_UNDO_ORIGINAL_PLAN.md`. See
`CLAUDE.md`'s feature-state summary for the current top-level status; this
file is the detailed design/rationale those summaries point back to.

## Context

The editor (`editor-pro/`) has two features queued up next: **search across the
whole podcast** and **filler-word removal**. Both need a word-level transcript
to work from. Neither Whisper transcription nor any compression step exists
in this codebase today — this plan builds the whole chain: compress on
upload/TTS → transcribe in the background via Whisper (OpenRouter) → make the
resulting word-level timestamps survive every existing clip operation (move,
trim, split, undo) → build search and filler-word removal on top.

The critical design constraint, confirmed against this app's actual data
model before anything else: **`ClipMeta`/`AudioClip`** (`utils/types.ts`)
already carries `assetId` (which source asset), `offsetSamples` (where this
clip starts inside that asset), `durationSamples` (how much of the asset this
clip uses), `startSample` (where the clip sits on the timeline), and
`sourceDurationSamples`. A move only ever changes `startSample`; a trim only
ever changes `offsetSamples`/`durationSamples`; a split (confirmed via
`utils/assetRegistry.ts`'s `getAssetId` — the library passes the same buffer
by reference to both halves) keeps the same `assetId`. So: **store one
transcript per `assetId`, in seconds relative to that asset's own start —
never per-clip, never on the timeline** — and every existing clip operation
except a splice (silence removal, filler-word removal itself) already
preserves it for free, with zero new invalidation logic needed for move/
trim/split/undo.

## Decisions locked in for this plan

- Model: Whisper via OpenRouter — `POST https://openrouter.ai/api/v1/audio/transcriptions`,
  `model: "openai/whisper-large-v3"`, `response_format: "verbose_json"`,
  `timestamp_granularities: ["word"]`, multipart/form-data upload (`file`).
  Response: `{ text, usage: {seconds, cost}, language, duration, words: [{ word, start, end }] }`
  — start/end in seconds, field is `word` not `text` (confirmed live in
  Phase 0, corrected from the docs' initial description — same discipline
  this repo already applies to Cartesia, CLAUDE.md's TTS section finding 2).
- **Compression = chunk-first, then Opus-encode each chunk.** OpenRouter's
  25MB cap AND a ~60s upstream processing timeout (independent of file size —
  a tiny-but-long Opus file can still time out) both apply. Chunking by
  duration (~10 min/chunk) solves both at once: a 10-minute chunk is trivially
  under 25MB at any speech-appropriate bitrate, and each transcription request
  is short enough to finish well inside the timeout. **The "compressed
  version" stored in IndexedDB is therefore an array of small chunk blobs per
  asset, not one whole-asset file** — chosen explicitly over keeping one
  whole compressed file and re-slicing it later, to avoid a second re-encode
  pass and because the chunks are reused as-is for the transcription request
  bodies.
- Both the original asset and its compressed chunks persist in IndexedDB;
  transcripts persist in IndexedDB too (not localStorage — matches every
  other non-trivial store this app already uses, avoids localStorage's small
  synchronous quota on a multi-hour podcast's word list).
- Filler-word removal: **per-clip**, triggered from the same "..." clip menu
  as "Remove silence" — consistent with the existing pattern, one clip's cuts
  = one batch commit = one undo step. Detected occurrences are shown in a
  **review modal** (word + context + timestamp, individually checked), not
  auto-removed — word-dictionary matching has real false positives ("like" as
  a verb) that RMS-based silence detection never had.
- Search scope: only words whose timestamp falls inside some clip's
  currently-used `[offsetSamples, offsetSamples+durationSamples)` window —
  i.e. audio actually on the timeline, not trimmed-away source material.
- Spliced clips (silence removal, filler-word removal) mint a new
  content-hash `assetId` with no transcript. **Remap the old transcript
  through the known kept/removed ranges, locally, no network call** — keeps
  splice-based features fast/free/client-side, matches silence removal's
  existing property exactly. A word straddling a cut boundary is dropped, not
  truncated (simplest, safe default). Falls back to a real transcription call
  only if the source clip had no finished transcript to remap from.
- **Transcription is invisible to search; filler-word removal is disabled
  until ready.** Per the user's explicit call: opening/running search must
  never surface "transcription in progress" as a concept — if a relevant
  clip's transcript isn't done yet, search silently waits for it (a plain
  "Searching…" state, not a transcription-specific one) before returning
  results. The filler-word-removal menu item, by contrast, is simply
  **disabled** on any clip whose asset transcript isn't `"done"` yet — no
  modal to open until there's something to detect.

## Phase 0 — Verification spike (DONE — confirmed live, not just from docs)

1. **Live OpenRouter call** — confirmed via a real request (real Cartesia-
   synthesized speech -> OpenRouter): `words` comes back populated,
   accurately, as `[{ word, start, end }]` (field is `word`, not `text` as
   initially assumed from docs — corrected everywhere below). Top-level
   response: `{ text, usage: {seconds, cost}, language, duration, words }`.
2. **Opus-encode-from-an-already-decoded-buffer** — confirmed working via
   **`mediabunny`** (npm, actively maintained, zero runtime dependencies,
   MIT). `opus-recorder` was tried first and rejected: confirmed via its own
   README that it's built exclusively around live `MediaStream` capture, with
   no supported way to feed it an already-decoded buffer without literally
   replaying it in real time (a dealbreaker — a 2-hour asset would take 2
   hours to "encode"); its own maintainer now points users to WebCodecs
   instead. `mediabunny`'s `AudioBufferSource` (`new
   AudioBufferSource({codec: 'opus', bitrate})`, `.add(audioBuffer)` — takes
   a real `AudioBuffer` directly) + `OggOutputFormat` + `BufferTarget`
   confirmed end-to-end in a real Chromium page: encode -> round-trip through
   `decodeAudioData` (valid, playable) -> send the compressed file to
   OpenRouter -> word timestamps still come back correctly. Real numbers: a
   ~5s real-speech clip compressed from 418KB (WAV) to 13KB (mono/16kHz Opus,
   24kbps) — ~97% smaller.
   - **Requires a secure context** (`AudioEncoder` is `undefined` otherwise —
     confirmed by reproducing the failure on `about:blank` and fixing it by
     serving from `http://127.0.0.1`). Not a real constraint: this app is
     always served from `localhost` (dev/`next start`) or real HTTPS in any
     deployment, both qualify.
   - Playwright's default headless launch (`chromium_headless_shell`) does
     NOT expose `AudioEncoder` at all — irrelevant to the shipped app (real
     Chrome/Chromium always has it), but **e2e tests for this feature must
     launch the full Chromium binary**, not rely on `@playwright/test`'s
     default headless shell config, or they'll spuriously fail. Flagged for
     `playwright.config.ts` when Phase 6's e2e coverage is written.
3. Chunk duration: keep the ~10 min/chunk starting point (comfortably safe on
   both the size and timeout fronts given the ~97% compression ratio
   measured). Mono downmix confirmed cheap and correct via
   `OfflineAudioContext` (equal-gain sum of all channels into one).

**New dependency**: `mediabunny` — added to `editor-pro/package.json`.

## Phase 1 — Data model + IndexedDB schema

New types in `src/utils/types.ts`:

```ts
export interface TranscriptWord { word: string; start: number; end: number; } // seconds, asset-relative
export type TranscriptStatus = "pending" | "transcribing" | "done" | "failed";
export interface AssetTranscript {
  assetId: string;
  status: TranscriptStatus;
  words: TranscriptWord[] | null;
  partialFailure?: boolean; // some chunks failed, others succeeded
  error?: string;
  updatedAt: number;
}
export interface CompressedChunk { startSample: number; endSample: number; blob: Blob; }
```

`src/utils/persistence.ts` — bump `DB_VERSION` to 2, guard `upgrade()` on
`oldVersion` so the existing `project`/`assets` stores aren't recreated:

```ts
upgrade(db, oldVersion) {
  if (oldVersion < 1) { db.createObjectStore(PROJECT_STORE); db.createObjectStore(ASSETS_STORE); }
  if (oldVersion < 2) {
    db.createObjectStore(COMPRESSED_ASSETS_STORE); // key: assetId, value: { chunks: {startSample, endSample, blob, mimeType}[], addedAt }
    db.createObjectStore(TRANSCRIPTS_STORE);        // key: assetId, value: AssetTranscript
  }
}
```

New functions mirroring the existing `saveAsset`/`loadAsset`/`loadAssets`
shape: `saveCompressedAsset`, `loadCompressedAsset`, `saveTranscript`,
`loadTranscript`, `loadTranscripts` (batched, same pattern `loadAssets`
already uses for hydration).

New `src/store/transcriptStore.ts` (Zustand, `assetId -> AssetTranscript`).
**Deliberately never wired into `projectStore.ts` or threaded above/inside
`TimelineStage.tsx`** — this sidesteps a repeat of the documented
`processingClipId` bug (CLAUDE.md's silence-removal section, bug 4): any
state that changes independently of a real `commit()`, if visible above
`TimelineStage`, defeats its passthrough-cache and forces spurious full
engine rebuilds. Transcription status changes constantly and asynchronously,
completely independent of `commit()` — it must stay below/beside
`TimelineStage`, same relocation fix already applied there for exactly this
reason.

## Phase 2 — Compression pipeline (upload + TTS paths)

New pure module `src/utils/audioCompression.ts`:
- `splitBufferIntoChunks(buffer, chunkDurationSeconds)` — pure sample math.
- `downmixToMono(buffer)`.
- `encodeOpusChunk(buffer, startSample, endSample): Promise<Blob>` — mediabunny
  `AudioBufferSource` + `OggOutputFormat` + `BufferTarget`, confirmed in
  Phase 0.
- `compressAssetToChunks(buffer): Promise<CompressedChunk[]>`.

Wiring, extending (not replacing) the existing decode→hash→register→persist→
commit flow:
- `useTimelineTracks.ts`'s `addFilesToTrack`: after `decodeAudioData`/
  `registerAsset`, compress + `saveCompressedAsset` inside the same
  `Promise.all` that currently covers decode + `saveAsset`, before
  `setLoadingCount` decrements — this is what makes the existing upload
  loading overlay wait for compression too, per the UX requirement. A
  compression failure is logged/counted and swallowed the same non-fatal way
  an asset-save failure already is.
- `useGenerateSpeech.ts`: identical addition after its own `decodeAudioData`/
  `registerAsset`, before the hook resolves.
- After each, kick off transcription (Phase 3) **without awaiting it** — this
  is the "background" half of the requirement; the user can start editing
  immediately.

## Phase 3 — Server route + background transcription

New `src/app/api/transcribe/route.ts`, mirroring `api/tts/route.ts`'s shape:
holds `OPENROUTER_API_KEY` server-side, accepts one chunk's compressed blob
(multipart, forwarded from the client — no base64 bloat), calls OpenRouter,
returns `words`. **One request = one chunk** — client owns fan-out and
merging, same "server is a thin per-request proxy" precedent `/api/tts`
already sets. Same retry discipline as `requestCartesiaTtsWithRetry`
(`api/tts/route.ts`): retry once on 429/5xx only, never on 4xx, fresh timeout
per attempt.

New `src/utils/transcription.ts`'s `runTranscriptionPipeline(assetId,
chunks): Promise<void>` — a plain function, not a hook (must be callable from
both `addFilesToTrack`'s async IIFE and `generateSpeech`'s async function).
Reads/writes `transcriptStore` via `getState()`/`setState()` outside React,
same pattern `projectStore.ts` already uses for its own module-level
`stopIfPlaying`:
1. Write `{status: "transcribing", words: null}` immediately.
2. Fire all chunk requests to `/api/transcribe` in parallel
   (`Promise.allSettled`).
3. Offset each fulfilled chunk's words by `chunk.startSample/sampleRate`,
   merge + sort.
4. All succeeded → `"done"`. Some succeeded → `"done"` + `partialFailure` +
   `error`. None succeeded → `"failed"`.
5. Persist via `saveTranscript` and write to `transcriptStore`.

**Reload/hydration**: `useProjectHydration.ts` needs a matching batch-load of
transcripts for every referenced `assetId` (mirrors `loadAssets`'s existing
pattern). Any transcript still `"pending"`/`"transcribing"` at reload time
(tab closed mid-flight) is re-kicked via `runTranscriptionPipeline` against
the already-persisted compressed chunks — cheap, no re-decode/re-compress.

## Phase 4 — Re-transcription for spliced assets (DONE, verified live)

`useRemoveSilence.ts` and the new filler-word hook both splice a new buffer →
new `assetId` with no transcript. New `src/utils/transcriptRemap.ts`:
`remapWordsThroughKeptRanges(words, keepRanges, sampleRate): TranscriptWord[]`
— walks the same concatenation math `concatenateAudioData` performs, in time
units: a word fully inside a kept range gets
`newStart = (sum of prior kept-ranges' durations) + (word.start - range.startSeconds)`;
a word straddling a cut boundary is dropped entirely, not truncated.

Requires a small additive change to `spliceOutSilence`'s return shape (also
return `keepRanges`, not just the two boolean edge-flags it returns today) —
low-risk, backward compatible; the same shape gets reused by the filler-word
splice path in Phase 6. If the source clip's transcript wasn't `"done"` at
splice time (still transcribing, failed, predates this feature), fall back to
a real `runTranscriptionPipeline` call on the new asset instead — nothing to
remap from.

**Verified live** against a real production build: a synthetic clip built
from two real Cartesia-synthesized phrases separated by a genuine 3s digital-
silence gap, uploaded, transcribed (16 words), then run through "Remove
silence" via the actual clip menu. Confirmed: all 16 words survived (none
straddling the removed gap), the new asset's transcript appeared **~7ms**
after the splice committed (versus 500ms-2s+ for every observed real
OpenRouter call — unambiguous proof the local remap path ran, not the
network fallback), and the first word after the gap shifted from 4.99s to
2.21s post-splice — a ~2.78s shift, matching the ~3s gap minus the padding
silence-removal keeps on each side of a cut. Zero console/page errors.

## Phase 5 — Audio search (DONE, verified live)

Shared foundation: `src/hooks/useTranscriptIndex.ts` — for every clip on
every track, reads `transcriptStore`, filters words whose `[start,end)`
overlaps `[offsetSamples/sampleRate, (offsetSamples+durationSamples)/sampleRate)`,
maps each to a timeline sample position
`clip.startSample + Math.round(word.start*sampleRate) - offsetSamples`.
Memoized on `(tracks, transcriptStore snapshot)`.

**Transcription must stay invisible to the searching user.** Before running a
search, the hook checks every currently-relevant clip's transcript status;
if any is `"pending"`/`"transcribing"`, the search UI shows a plain
"Searching…" state (never mentions transcription) and waits for those to
settle before computing results — a `"failed"` transcript is simply excluded
from results (its clip's words never existed as far as search is concerned),
not surfaced as an error.

UI: a TopBar-anchored popover (not a modal — search is a quick, repeated
action), portaled/positioned the way `ClipActionsMenu.tsx`/`MenuButton.tsx`
already do, debounced case-insensitive substring match for v1 (index is
already cheap; matching logic can be swapped later without touching it).
Each result: clip name, matched word + surrounding context, mm:ss. Clicking a
result sets `EditorShell.tsx`'s existing `selectedClip` state (threaded down
as a new callback prop through `TopBar`), seeks playback (verify the exact
`usePlaylistControls()` method name against the vendored `.d.ts` at
implementation time — same discipline CLAUDE.md's "Track selection split
across three hooks" section already establishes for this library), and
scrolls the existing `scrollEl` into view.

## Phase 6 — Filler-word removal

Dictionary: new `src/utils/fillerWords.ts`, curated + hardcoded for v1 (same
"not fetched at runtime" precedent as `cartesiaVoices.ts`). Multi-word
fillers ("you know", "i mean") need sliding-window n-gram matching over
consecutive `words[]` entries, since Whisper returns single tokens. High-
confidence fillers ("um", "uh", "erm", "hmm") pre-checked by default in the
review modal; ambiguous ones ("like", "so", "actually", "you know") start
unchecked, requiring opt-in.

Per-clip "..." menu item ("Remove filler words", next to "Remove silence" in
`ClipActionsOverlay.tsx`'s `buildActions`) is **disabled whenever that clip's
asset transcript status isn't `"done"`** — no modal opens until there's
something to review; this is the one place transcription state is allowed to
surface, and only as a disabled control, never an explanation of why.

Mechanics: reuse `useTranscriptIndex` scoped to the target clip for
detection. Extract the splice-application tail of `silenceDetection.ts`'s
`spliceOutSilence` (everything from `concatenateAudioData` onward) into a
shared `spliceKeepRanges(...)` helper — both features are mechanically
"detect ranges to remove → invert to keepRanges → splice", only the detector
differs. New `useFillerWordRemoval.ts` mirrors `useRemoveSilence.ts`'s full
discipline point-for-point: single-flight guard, yield-before-CPU-bound-work,
pre-commit re-check of live clip boundaries, toast outcome, full-editor
blocking overlay, exactly one `commit()` call (label "Remove filler words")
for the whole batch.

New `src/components/filler-words/FillerWordReviewModal.tsx`, modeled on
`GenerateSpeechModal.tsx`'s portaled-centered-modal shape, checkbox list
instead of a form.

**Cross-feature coordination, new gap found while designing this**:
`useRemoveSilence.ts` and `useFillerWordRemoval.ts` are each independently
app-wide single-flight (their own `isProcessingRef`), but nothing coordinates
*between* them — silence removal on clip A and filler removal on clip B
triggered together would stack two full-editor blocking overlays.
`EditorShell.tsx` needs a combined `isBusyProcessingClip = isRemovingSilence
|| isApplyingFillerRemoval` gating both menu items and rendering only one
overlay.

## Explicitly disclosed risks / not silently resolved

1. ~~Whether OpenRouter actually honors `timestamp_granularities` end-to-end~~
   — **resolved in Phase 0**: confirmed live, twice (once against a raw WAV,
   once against the actual compressed Opus file this pipeline produces).
2. Cost: unlike TTS (opt-in), transcription runs on every upload/TTS
   generation per the spec — real, ongoing OpenRouter spend, not a design
   decision point here but worth the user seeing it stated plainly. Measured:
   ~$0.00013/5s of speech in Phase 0's spike (~$0.0016/min).
3. Exact filler-word dictionary is a v1 recommendation, trivially tunable
   later.
4. A `"failed"` transcript (all chunks failed) leaves that clip permanently
   excluded from search and filler-word removal until... nothing currently
   retries it automatically beyond the reload-time re-kick in Phase 3 — a
   manual retry affordance isn't in this plan's v1 scope; flagged, not built.

## Verification

- Phase 0's spikes are throwaway scripts, verified manually, not committed.
- New pure logic (`splitBufferIntoChunks`, `remapWordsThroughKeptRanges`,
  filler-word n-gram matching) gets a Node-side unit pass before touching a
  browser — same order-of-operations discipline `silenceDetection.ts` already
  established (cheapest place to catch algorithm bugs first).
- Full Playwright suite (currently 69 tests) must stay green throughout;
  new e2e coverage follows the existing per-feature-file convention
  (`e2e/transcription.spec.ts`, `e2e/search.spec.ts`,
  `e2e/fillerWordRemoval.spec.ts`), mocking `/api/transcribe` at the browser
  level for UI coverage plus a `ttsRoute.spec.ts`-style direct-import test for
  the route handler's own logic (retry behavior, validation) — same reasoning
  CLAUDE.md's TTS section finding 5 already documents for why browser-level
  mocking alone doesn't cover a route handler.
- Manual pass against a real multi-chunk (>10 min) recording once Phase 0-3
  land, to confirm chunk-merge produces correctly-offset, correctly-ordered
  word timestamps against real Whisper output — not just synthetic fixtures.
