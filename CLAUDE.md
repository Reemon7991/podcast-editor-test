@AGENTS.md

# Podcast Editor — @waveform-playlist/browser Evaluation

This is a **proof of concept**, not a production app. The goal is to evaluate
whether `@waveform-playlist/browser` is a suitable foundation for a
browser-based podcast/multi-track editor — performance, stability, developer
experience, and how far its built-in abstractions actually stretch before you
have to drop into custom code. Every non-obvious decision below exists
because of something concretely discovered while building this, not
speculation — treat this file as the fastest way to avoid re-deriving that
work in a future session.

## Current feature state

1. Single-file playback (load one audio file, waveform, play/pause, seek,
   zoom, scroll, time display) — done, verified.
2. Multi-clip single-track timeline (import multiple files, position
   sequentially or with a gap, play as one continuous timeline) — done,
   verified.
3. Multi-track + clip dragging (multiple tracks, drag clips horizontally
   within a track, drag clips vertically to another track) — **implemented,
   one known bug in progress** (see "Open issue" below).

## Architecture

```text
app/page.tsx                              server component, renders PodcastEditorLoader
components/podcast-editor/
  PodcastEditorLoader.tsx                 next/dynamic(ssr:false) wrapper — REQUIRED, see below
  PodcastEditor.tsx                       top-level state owner: useTimelineTracks + gap setting
  useTimelineTracks.ts                    tracks[] as persisted state; addTrack/removeTrack/addFilesToTrack
  TrackListBar.tsx                        "Add track" + per-track "Add clip" file inputs
  TimelineStage.tsx                       wraps WaveformPlaylistProvider (tracks, onTracksChange, controls)
  trackLayout.ts                          TRACK_WAVE_HEIGHT + TRACK_ROW_HEIGHT_PX (empirically measured)
  EditorShell.tsx                         TransportControls + ClipDragLayer(<Waveform showClipHeaders/>)
  ClipDragLayer.tsx                       custom drag interaction layer — see "Clip dragging" below
  TransportControls.tsx                   PlayButton/PauseButton/ZoomIn/ZoomOut (library components) + time
  PlaybackTime.tsx                        live time display, registerFrameCallback-driven (NOT React state)
  DurationLabel.tsx                       total duration display
```

Every file under `components/podcast-editor/` is `"use client"`. Nothing
outside this folder needs to change to extend the feature set further.

## Critical setup gotchas (do not re-discover these)

- **`styled-components` must be installed manually.** It's a hard runtime
  import inside `@waveform-playlist/browser`'s bundle but isn't declared as
  an installed dependency by default — the app crashes at runtime without it.
  Already fixed (`styled-components@6.4.3` in `package.json`).
- **`PodcastEditorLoader.tsx`'s `next/dynamic(..., { ssr: false })` is
  required, not optional.** Tone.js touches `window`/`AudioContext` at
  module-evaluation time. Since Next.js server-renders "use client" trees on
  their first HTML pass by default, mounting the editor tree directly from a
  server component throws `ReferenceError: window is not defined` at build
  time. The `ssr:false` wrapper must live in its own Client Component per
  Next's own docs — it cannot be set from a Server Component.
- This project's Next.js/React/Tailwind versions are intentionally bleeding
  edge (see `AGENTS.md` — "not the Next.js you know"). Check
  `node_modules/next/dist/docs/` before assuming standard Next.js behavior.

## Library findings worth remembering

### `MediaElementPlaylistProvider` vs `WaveformPlaylistProvider`

The library ships a lightweight `MediaElementPlaylistProvider` explicitly
recommended for "podcast players" (streams via `<audio>`, no full-buffer
decode). **We don't use it** — inspecting its source showed `samplesPerPixel`
is `useState`'d once with no setter and no zoom controls at all in that mode.
Since zoom is a hard requirement, we use `WaveformPlaylistProvider`
(Tone.js-backed) instead, which has full `zoomIn`/`zoomOut`. Tradeoff: every
clip's full PCM buffer stays resident in memory (Tone.js decode, not
streamed) — the thing to watch first if this ever gets stress-tested with
genuinely ~1hr of real audio content across many clips.

### `usePlaybackAnimation().currentTime` is not a live value

It's a checkpoint set only at play/pause/stop/seek boundaries, not every
frame — using it directly for a live time display renders a frozen clock
during playback. The real 60fps clock lives behind `registerFrameCallback`
(ref-based, no re-render). `PlaybackTime.tsx` writes the formatted time
directly into the DOM via a ref inside that callback — this also means it
never triggers a React re-render during playback, which is a bonus, not just
a workaround.

### `useDynamicTracks` (from `@waveform-playlist/browser/tone`) has a real bug

It's the library's own "incremental file add without re-decoding everything"
hook — exactly the right shape for scalability. But it has a reproducible
bug (confirmed in both dev and prod builds, not a Strict Mode artifact):
`decodeAudioData` resolves correctly, but the hook's internal placeholder
state never flips to "ready" — the UI hangs on the loading state forever
even though decode succeeded. **We don't use it.** `useTimelineTracks.ts`
implements the same incremental-add shape directly (~100 lines: decode via
`Tone.getContext().rawContext.decodeAudioData`, build `AudioClip` objects by
hand, `setTracks` incrementally) — same scalability property (adding N files
costs O(N), never re-touches previously loaded clips), without the bug.

### Batch file imports: decode order ≠ selection order

Found via testing: if you decode each file in a batch independently and
append-on-resolve, a smaller/faster file can finish decoding before a larger
one selected earlier, silently reordering the timeline relative to what the
user picked in the file dialog. Fixed in `useTimelineTracks.addFilesToTrack`:
decode all files in a batch concurrently (`Promise.allSettled`, still fast),
but only commit to `tracks` state once, in one update, iterating in the
*original* file-selection order.

### Clip dragging: `ClipInteractionProvider` alone isn't enough

This was the most involved discovery. `ClipInteractionProvider` is the
library's turnkey drag layer, but:

1. It **unconditionally applies `RestrictToHorizontalAxis`** — no prop to
   disable it. Cross-track (vertical) dragging is impossible through it.
2. `engine.moveClip(trackId, clipId, deltaSamples)` — what its `onDragEnd`
   calls — has **no track parameter at all**. There is no
   "move clip to a different track" primitive anywhere in the engine.
3. Whether `<Waveform>` renders clips as draggable at all is gated by an
   **internal React context flag that only `ClipInteractionProvider` can
   set** (`ClipInteractionContext`, not exported — `useClipInteractionEnabled`
   is exported to *read* it, nothing is exported to *set* it yourself).

Because of (3), `ClipDragLayer.tsx` still mounts `ClipInteractionProvider`
(purely for that context side effect) but nests its **own**
`DragDropProvider` from `@dnd-kit/react` inside it. Draggables always bind to
the *nearest* `DragDropProvider` ancestor, so the inner one takes over all
real interaction — the outer one (with its hardcoded horizontal restriction)
ends up with nothing registered against it. This is intentional, not
accidental redundancy.

Cross-track target detection uses `event.operation.position` (raw pointer
delta), confirmed via source reading to be **modifier-independent** — unlike
`event.operation.transform`, which a horizontal-axis modifier would zero on
Y. The vertical delta is divided by `TRACK_ROW_HEIGHT_PX`
(`trackLayout.ts`), an **empirically measured constant** (waveform height +
the clip-header row reserved when `showClipHeaders` is on — 22px, not exposed
via any prop). Confirmed stable via two independent DOM anchors (per-track
control label, Mute button) across empty and populated tracks. Revisit this
constant if `TRACK_WAVE_HEIGHT` or `showClipHeaders` usage changes.

`constrainClipDrag` (from `@waveform-playlist/engine`) **is** publicly
exported and reused directly for collision-safety — same math
`engine.moveClip()` uses internally, just applied to a track/position the
clip isn't natively being moved through the engine for.

## Verification approach (no permanent test suite)

There is no Playwright/Jest setup committed to this repo. All verification
so far has been done via **ad-hoc scripts in the session scratchpad**
(`playwright-core`, launched against `npm run build && next start`, not
`next dev` — dev-mode Turbopack/Strict Mode double-invocation was ruled out
as a cause for bugs found this way, so prod-build testing is the reliable
signal). If picking this project back up:

- `npm install playwright-core@1.61.1` in a scratch dir (chromium binary is
  typically already cached under `~/AppData/Local/ms-playwright` on this
  machine).
- Generate tiny synthetic WAV files with a Node script (raw PCM sine wave,
  44-byte RIFF header) rather than depending on real audio assets.
- Prefer `data-testid` selectors (`current-time`, `total-duration` exist
  already) over CSS class selectors — `font-mono` is reused by both the
  transport bar's live time display AND `TrackListBar`'s per-clip duration
  labels, which caused a real false-bug diagnosis earlier from an ambiguous
  `.first()` locator match.
- The draggable clip element is `[data-clip-id]:not([data-boundary-edge])`
  (the clip's header bar) — not the waveform `<canvas>`, and not the
  `data-boundary-edge="left"|"right"` trim handles.

## Open issue — clip reorder-past-a-neighbor drag (IN PROGRESS)

**Symptom reported by user:** dragging a clip so it overlaps a neighbor that
sits *before* it in time snaps back to its original position instead of
reordering.

**Root cause, confirmed by reading `constrainClipDrag` in
`@waveform-playlist/engine`:** the earlier fix (`resolveDropPosition` in
`ClipDragLayer.tsx`, still in the file as of this writing) determines a
clip's new neighbors by inserting it into a freshly-sorted list at its
*proposed* position and clamping via `constrainClipDrag`. This correctly
allows reordering *only* once the dragged clip's proposed **start** position
moves fully past the neighbor's own start (i.e. the sort order flips). For
two clips of comparable size, that requires dragging clear across the
*entire* neighbor's width, not just "onto" it — and if the neighbor sits at
or near the timeline's own start (t=0, the common case for a first clip),
there may be no numeric room for this to ever succeed, so it silently clamps
back to "flush after the neighbor" — which looks identical to "did nothing."

**Diagnosis, not yet applied to the file:** real drag-to-reorder UX (as in
sortable lists) should trigger a swap once the dragged clip's **center**
crosses the neighbor's **center** — not require clearing its entire span. A
`resolveSameTrackMove(clip, sampleDelta, trackClips)` function was drafted
(and reviewed with the user before being interrupted mid-write) that:

1. Finds the clip's current immediate `prevClip`/`nextClip` via a sorted
   lookup (same shape as the engine's own approach).
2. If the proposed center has crossed `prevClip`'s center: **swap** — the
   dragged clip takes `prevClip`'s old start, and `prevClip` moves to start
   right after it (dragged clip's duration later).
3. Same check mirrored for `nextClip` (dragging right past a neighbor).
4. Otherwise: falls back to the existing clamped-slide behavior (unchanged).

This only swaps with the *single* immediate neighbor being crossed — it does
not cascade through multiple clips in one drag (an acceptable, explicitly
scoped limitation; sequential drags cover multi-position moves). Cross-track
drops keep using the existing `resolveCrossTrackDrop`/`constrainClipDrag`
approach unchanged — there's no "current neighbor" to swap with when
inserting onto a track the clip wasn't already on.

**Next step:** implement `resolveSameTrackMove` in `ClipDragLayer.tsx`,
branch `onDragEnd` on `targetTrackIndex === sourceTrackIndex` to use it
instead of `resolveDropPosition` for the same-track case, keep
`resolveCrossTrackDrop` for the cross-track case, then re-verify against the
previously-passing scenarios before considering this closed:

- Same-track simple slide (no reorder) — must still be pixel-exact.
- Same-track reorder (drag clip A past clip B) — must now trigger on
  crossing B's midpoint, not require clearing its full width.
- Cross-track move — must be unaffected.
- No console errors, playback still works after each.

## Known limitations (disclosed, not silently accepted)

- Cross-track collision is enforced only at drop, not with live visual
  feedback during the drag (same-track drags get the full
  `engine.moveClip()`-driven experience since that's still the library's own
  live-feedback path for the non-reordering case).
- No undo/redo wiring for clip moves that go through `onTracksChange`
  directly (same-track non-reorder slides still go through the engine's own
  transaction system when unaffected; reorders and cross-track moves bypass
  it by design, since there's no engine primitive to hook into for either).
- Memory: full Tone.js decode per clip, all resident simultaneously. Scale
  testing so far (15 tracks × 8 short synthetic clips = 120 clips) validated
  *structural/rendering* scalability, not real memory footprint at ~1hr of
  actual audio content — that's the next thing to stress-test for real
  before trusting this architecture at production scale.
