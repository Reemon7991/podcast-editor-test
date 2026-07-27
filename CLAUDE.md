@AGENTS.md

# Podcast Editor — browser multi-track podcast editor (production-hardening)

Built on `@waveform-playlist/browser`. **Started as a proof-of-concept**
evaluating whether that library was a suitable foundation for a
browser-based podcast/multi-track editor — the early sections of this file
still reflect that phase (performance, stability, developer experience, how
far its built-in abstractions stretch before you have to drop into custom
code). **The project has since moved into production-hardening**: real bugs
found via reading app and library sources directly, fixed, and verified
end-to-end via Playwright against production builds — not just probing the
library's fit anymore. It is not yet shippable — see "Known limitations" for
the concrete gaps still open (export; undo/redo is done and persistence is in
progress — see "Persistence + Undo/Redo layer" below — including a committed
test suite, though so far scoped to that layer, not the rest of the app).
Every non-obvious decision below exists because of something concretely
discovered while building this, not speculation — treat this file as the
fastest way to avoid re-deriving that work in a future session.

## Current feature state

1. Single-file playback (load one audio file, waveform, play/pause, seek,
   zoom, scroll, time display) — done, verified.
2. Multi-clip single-track timeline (import multiple files via "Upload clip",
   inserted back-to-back starting at the current playhead position into the
   active track; play as one continuous timeline) — done; verified for the
   original append-at-end/gap design, **not yet re-verified** for the current
   insert-at-playhead behavior (see `useTimelineTracks.addFilesToTrack`) —
   treat that specific insertion path as untested until it's exercised
   end-to-end.
3. Multi-track + clip dragging (multiple tracks, drag clips horizontally
   within a track, drag clips vertically to another track, drop anywhere
   including on top of another clip — overlap is intentional, see "Superseded
   issue" below) — implemented; remaining known issues tracked in
   `timeline/EditorShell.tsx`'s own doc comment (the scroll-reset-on-rebuild
   history, including a real vendored-library bug found along the way that
   is diagnosed but **not actually patched** — no `patch-package` setup or
   `patches/` directory exists in this repo despite earlier documentation
   here claiming otherwise), not all of them closed — check those before
   assuming a fix is live in the current code.

## Planned features (not started)

None of the following exist yet — no partial implementation, no dedicated
branch. Listed here so a future session picks the right next slice of work
instead of re-deriving this list from a feature request. Roughly in the
order they'd naturally unblock each other (persistence/undo before export
makes sense to build on top of; split/fades and effects are independent of
those two; the AI features are the most speculative and probably last).

1. **Persistence** — project state (tracks/clips, decoded audio) survives
   a reload. **In progress, not done yet** — see "Persistence + Undo/Redo
   layer" below for current status; don't treat this bullet as current truth,
   it's only kept here for the ordering rationale in the paragraph above.
2. **Undo/redo** — the library's own `WaveformPlaylistProvider` context
   already exposes `undo`/`redo`/`canUndo`/`canRedo` (confirmed in
   `@waveform-playlist/browser`'s public `.d.ts`), but those only cover
   engine-driven transactions, which is why this needs its own command/history
   layer independent of the library's internal one. **Done** — see
   "Persistence + Undo/Redo layer" below for the actual design (superseded
   the sketch this bullet used to contain) and the real bugs found building it.
3. **Export** — render the mixdown (all tracks/clips/gains) to an audio file
   the user can download. Currently the editor can only play back in-browser;
   there's no way to get audio out of it at all.
4. **Split and fade in / fade out** — clip-level editing beyond move/trim.
   The library's `Clip` props already include `fadeIn`/`fadeOut` fields and a
   `showFades` flag (see the peaks-rendering code referenced in "Clip
   moves") — we just never enable it (`<Waveform>` is rendered without
   `showFades` in `EditorShell.tsx`). Worth checking how much of the
   rendering side the library already covers before building fade UI from
   scratch.
5. **Audio effects** — per-clip or per-track processing (EQ, compression,
   gain automation, etc. — scope not yet defined).
6. **AI features** — noise removal, humming removal, silence removal.
   Almost certainly needs server-side processing (not in-browser WebAudio) —
   scope, model/service choice, and where the compute runs are all open.

## Architecture

```text
src/
  app/page.tsx                             server component, renders PodcastEditorLoader
  components/
    PodcastEditorLoader.tsx                next/dynamic(ssr:false) wrapper — REQUIRED, see below
    PodcastEditor.tsx                      top-level state owner: useTimelineTracks; threads addTrack/addFilesToTrack down to TimelineStage
    timeline/
      TimelineStage.tsx                    wraps WaveformPlaylistProvider (tracks, onTracksChange, controls)
      EditorShell.tsx                      TransportControls + "New Track" button + ClipDragLayer(<Waveform showClipHeaders/>); also does manual track-click selection (see "Track selection" below)
      ClipDragLayer.tsx                    custom drag interaction layer — see "Clip dragging" below
    transport/
      TransportControls.tsx                PlayButton/PauseButton/ZoomIn/ZoomOut (library components) + time + "Upload clip" file input + UndoRedoButtons (see "Persistence + Undo/Redo layer" below)
      PlaybackTime.tsx                     live time display, registerFrameCallback-driven (NOT React state)
      DurationLabel.tsx                    total duration display
    clip-menu/
      ClipActionsOverlay.tsx               per-clip "..." menu (split/duplicate/delete), positioned over whichever clip the pointer is on
      ClipActionsMenu.tsx                  generic "..." trigger + dropdown, reusable beyond clips
  hooks/
    useTimelineTracks.ts                   tracks[] as persisted state; addTrack/removeTrack/addFilesToTrack(trackId, files, insertionTimeSeconds)
    useClipActions.ts                      duplicate/delete clip mutations
    useScissorsSplit.ts                    "click a clip to choose a split point" mode
  utils/
    trackLayout.ts                         TRACK_WAVE_HEIGHT + TRACK_ROW_HEIGHT_PX (empirically measured)
    clipGeometry.ts                        pixel↔sample hit-testing shared by ClipActionsOverlay/useScissorsSplit/ClipDragLayer
    types.ts, assetRegistry.ts,
    clipHydration.ts                       see "Persistence + Undo/Redo layer" below
  store/
    projectStore.ts                        see "Persistence + Undo/Redo layer" below
```

There is no `import/` folder anymore — `TrackListBar.tsx` (the old top-of-page
"Add track"/"Add clip" bar) was removed and its two responsibilities moved
into the components that already own that concern: adding a track lives in
`timeline/EditorShell.tsx` (the "New Track" button, since it's laid out under
the waveform's track-controls column), and adding clips lives in
`transport/TransportControls.tsx` (the "Upload clip" button, since it needs
the live playhead position from the same context transport controls already
read). Component subfolders still group by concern, not by original
evaluation order: `timeline/` owns the waveform stage and clip drag
interaction, `transport/` owns playback controls/time display and file
intake, `clip-menu/` owns the per-clip actions menu — `hooks/`, `utils/`, and
`store/` are the cross-cutting layers those draw on (React state, pure
logic/constants, and the undo/redo-aware store, respectively). Cross-folder
imports are relative. Every file under `src/components/`, `src/hooks/`, and
`src/store/` is `"use client"`; `src/utils/` files are plain TS with no
React/DOM dependency at module scope, so they don't carry the directive
themselves, but only ever run inside a client tree.

**Project-wide layer-based restructuring (done):** this `src/{app,components,
hooks,utils,store}` layout replaced a flatter `app/` + `components/podcast-
editor/{audio-engine,timeline,transport,clip-menu}` one — a standard
React/Next.js layout, requested explicitly (not something any feature plan
called for on its own), applied in one pass across the whole project rather
than scoped to whatever feature happened to be in progress at the time
(persistence/undo-redo, see below). Every file moved via `git mv` (history
preserved), every relative import fixed by hand; `tsc --noEmit`, `eslint`,
`npm run build`, and the full Playwright suite all re-run clean afterward
(the stale `.next/` build cache had to be deleted once — it still referenced
the old `app/` path). Key mapping, if a future session needs to find
something by its old path: `audio-engine/useTimelineTracks.ts`/
`useClipActions.ts` → `hooks/`; `audio-engine/persistence/
{clipHydration,assetRegistry,types}.ts` → `utils/` (flattened, no
`persistence/` subfolder anymore); `clip-menu/clipGeometry.ts` and
`timeline/trackLayout.ts` (pure functions/constants, no React) → `utils/`
too; `clip-menu/useScissorsSplit.ts` (a hook, not a pure util) → `hooks/`;
everything else (JSX components) stayed under `components/`, just one level
shallower — no more `podcast-editor/` wrapper, since the whole project is the
podcast editor.

## Persistence + Undo/Redo layer (undo/redo done, persistence in progress)

Full design: `PERSISTENCE_UNDO_ORIGINAL_PLAN.md` — written, reviewed against
this codebase's actual state (including a verification pass against the
installed `@waveform-playlist` dist source), and refined before any of the
phases below started; not a speculative design doc. Current branch:
`persistence-undo/redo-layer-2`. **Update this section after every phase
completes** — this file's whole value is not needing to re-derive what's
already been figured out, so don't let it drift behind the plan doc or the
actual code the way other sections of this file have occasionally been caught
out of date (see the `patch-package` correction in "Current feature state").

### Phase 0 — Committed test harness (done)

Replaced this project's prior ad-hoc-Playwright-script-per-session pattern
(see "Verification approach" below, now partially superseded for this layer)
with a real committed suite: `@playwright/test`, `playwright.config.ts` (runs
`npm run build && npm run start` — same prod-build-only rule as before),
`e2e/fixtures.ts` (synthetic WAV generation, promoted from a scratchpad
script), `e2e/helpers.ts`, `e2e/playback.spec.ts`. `npm run test:e2e` runs it.

### Phase 1 — Metadata/hydration boundary (done)

New `utils/types.ts` (`ClipMeta`/`TrackMeta` — `AudioClip`/`ClipTrack` minus
`audioBuffer`, plus a content-hash `assetId`), `utils/assetRegistry.ts`
(buffer↔assetId lookup table — `assetId` is minted from `SHA-256(file
bytes)`, not a random UUID, so two independent uploads of identical bytes
dedupe for free once persistence exists), `utils/clipHydration.ts`
(`hydrate`/`dehydrate` plus a per-track memoization cache). `TimelineStage.tsx`
is now the sole choke point between app state (`TrackMeta[]`) and the
hydrated `ClipTrack[]` shape `WaveformPlaylistProvider` actually needs.

Two things found while building this, worth not re-discovering:

- **`eslint-plugin-react-hooks`'s `refs` rule rejects reading `ref.current`
  during render, not just writing it.** This project's ESLint config
  (bleeding-edge Next.js/React, see AGENTS.md) enables it. The passthrough
  cache `TimelineStage.tsx` needs — to preserve `WaveformPlaylistProvider`'s
  `tracks === engineTracksRef.current` rebuild-avoidance check across the new
  `hydrate()` boundary — was originally designed around a ref; it has to be
  `useState` instead, since state is the idiomatic substitute for a value
  written from an event/effect callback and read during render. Confirmed
  this doesn't cost an extra render: the state setter and the parent's own
  `setTracks` both fire synchronously in the same callback tick, so React
  batches them into one commit.
- **The "Building waveform…" placeholder is not a reliable *automated* signal
  for "did a full engine rebuild happen."** It's a fine signal for a human
  watching a real, slow rebuild (large session, cold module cache) — that's
  what the play()/rebuild-race sections below already lean on. But for a
  small synthetic test clip over an already-warm dynamic-import cache (true
  for every rebuild after the first one on a given page load), the engine's
  `resolvePlayoutAdapter()` resolves via a microtask fast enough that React
  can batch the `isReady` false→true transition without ever committing an
  observably separate "not ready" DOM state — confirmed empirically (a
  MutationObserver watching for the placeholder text never fired across a
  rebuild that other evidence confirmed did happen). The reliable signal is
  the library's own `window` CustomEvent `"waveform-playlist:ready"`
  (confirmed in `@waveform-playlist/browser/dist/index.js` — dispatched
  exactly once, at the end of the full-rebuild `loadAudio()` path, never on
  the `isEngineTracks`/`isIncrementalAdd` skip-rebuild paths, which return
  early before reaching it). `e2e/helpers.ts`'s `rebuildsEngine()` listens for
  this instead.

Committed coverage (`e2e/hydration.spec.ts`, 7 tests, real `page.mouse`
pointer-drag sequences for drag/trim — not `locator.dragTo()`, which emulates
HTML5 DnD, a different mechanism than dnd-kit's `PointerSensor`): confirms
add-track, split, and boundary trim do **not** rebuild; duplicate, delete,
same-track drag, and cross-track drag **do** — every case the plan called
out. Full suite (9 tests total, this file plus `playback.spec.ts`) passed
repeatedly against a fresh prod build with no flake observed.

### Phase 2 — Undo/redo via Zustand (done)

`store/projectStore.ts` — `present`/`past`/`future`, plus `commit(update, label)`
for direct app-level mutations (add/remove track, duplicate, delete, import).
`hooks/useUndoRedoShortcut.ts` (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, mounted from
`EditorShell.tsx`) and `components/transport/UndoRedoButtons.tsx` (icon
buttons, not text — inline SVG matching `ClipActionsMenu.tsx`'s own
hand-rolled-icon pattern) both read the store directly. `useTimelineTracks.ts`/
`useClipActions.ts` now commit through the store instead of local `useState`.
`ClipActionsOverlay.tsx` gained the same `stop()`-if-`isPlaying` guard
`ClipDragLayer.tsx` already had, extended to duplicate/delete/undo/redo (a
real, pre-existing gap: those already forced a full rebuild via plain state
updates, so they could already hit the documented `TonePlayout not
initialized` crash during playback, independent of this phase).

Four real bugs found and fixed while building this — undo/redo turned out to
be a much better forcing function for surfacing engine-integration edge cases
than persistence-free rendering ever was, since every one of these was
invisible until something needed to *replay* history correctly, not just
render the current state:

- **The Phase 1 passthrough cache (`lastEngineOutput`) needed to move from
  `TimelineStage.tsx`'s `useState` into the store itself.** Keeping it as
  separate React state alongside the store's `present` update meant the two
  didn't always land in the same render (confirmed via direct
  instrumentation) — one extra render per commit saw the new `present` but
  the stale `lastEngineOutput`, which was enough to defeat
  `isEngineTracks` and trigger an avoidable full rebuild. Colocating both in
  one atomic `set()` call (`commitEngineOutput`) removed the gap entirely.
- **Trim's live-preview frames were flooding undo history.** Confirmed via
  direct instrumentation: `useClipDragHandlers`'s own `onDragMove` (used
  internally by `ClipDragLayer.tsx` for boundary/trim drags) calls
  `onTracksChange` on *every pointer-move frame* to drive the visual
  preview — a short trim drag fired it 10+ times, each becoming its own
  undo-able step. Fixed by having `ClipDragLayer.tsx` wrap the `onTracksChange`
  it passes into `useClipDragHandlers` with a version that routes to a new
  `updateEngineOutputLive` store action (updates `present` for the visual,
  never touches history) — the engine's *actual* commit (`trimClip()` +
  `commitTransaction()` at drag-end) is a completely separate call path that
  still reaches the real, history-pushing `commitEngineOutput` unwrapped.
- **The incremental-add path's own engine mirror-back was pushing a second,
  spurious history entry.** `useTimelineTracks.addTrack()`'s `commit()` call
  is one real edit, but `engine.addTrack()` (called internally by the
  provider's `isIncrementalAdd` path) triggers the engine's own "statechange"
  mirror-back purely to confirm what was already committed — which, before
  this fix, silently pushed a second "Edit timeline" entry with the same
  content. A single Undo only ever undid that harmless echo, never the actual
  add. Fixed with a structural-equality check (`utils/deepEqual.ts`, order-
  independent — needed since the engine's own object graph and the app's
  never match by reference) in `commitEngineOutput`: content-identical
  mirrors update `present`/`lastEngineOutput` (still needed for the
  passthrough cache) but skip the history push.
- **Even after the above, a trim's single Undo landed on the last
  live-preview frame, not the true pre-trim state.** Root cause:
  `updateEngineOutputLive` (the previous fix) continuously overwrites
  `present` throughout the drag so the waveform tracks it live — so by the
  time the drag settles, `present` already reflects something visually
  indistinguishable from the final trim, and using it as the undo entry's
  `before` undoes almost nothing. Fixed with an explicit `dragBaseline`
  field: `ClipDragLayer.tsx`'s `onDragStart` calls `beginLiveDrag()` (captures
  `present` once, gated on `data?.boundary` so a plain clip move never sets
  it) and `onDragEnd`'s cancelled-boundary-drag branch calls `cancelLiveDrag()`
  (clears it if the drag never reaches a real commit); `commitEngineOutput`
  uses `dragBaseline ?? present` as `before`, then clears it.

Committed coverage (`e2e/undoRedo.spec.ts`, 9 tests): undo/redo button and
keyboard-shortcut enablement, add-track and clip-import undo/redo, redo
clearing on a new commit after undo, trim undoing as one step (the exact
regression the fourth bug above produced), a stale-closure race regression
(an unrelated commit landing while an import's decode is still in flight must
survive, not get silently reverted — see `commit`'s own doc comment), and the
playback guard on duplicate and undo. Full suite (18 tests: this file,
`hydration.spec.ts`, `playback.spec.ts`) passed repeatedly against a fresh
prod build with no flake observed.

### Post-Phase-2 regression: "editing while playing" guard, now centralized (FIXED)

Phase 2 broke the "editing while already playing" fix documented further down
("A second, unrelated instance of the same race") — `tracks` moving into
Zustand meant `stop()`'s `setIsPlaying(false)` no longer reliably batches
into the same React commit as the tracks-changing commit, so the provider's
rebuild effect could still observe `isPlaying: true`. Two other mutations
(`addFilesToTrack`/"Upload clip", `removeTrack`) turned out to have never had
this guard at all, in any phase.

Fixed by centralizing into `store/projectStore.ts`: a module-level
`stopIfPlaying` callback (registered once from `EditorShell.tsx`, the
component with actual `stop()`/`isPlaying` access, via
`registerStopIfPlaying()`), called with `flushSync` from `commit`/`undo`/
`redo` before mutating. Every mutation that goes through `commit` — today
and any future one — gets the guard for free; `ClipActionsOverlay.tsx`/
`useUndoRedoShortcut.ts`/`UndoRedoButtons.tsx` dropped their now-redundant
local guards. `ClipDragLayer.tsx`'s move-drag guard stays local and manual
(the one exception): moves reach `commitEngineOutput`, which also carries
trim/split's engine-driven mirror-back that must **not** stop playback, and
only that call site can tell the two apart.

Also fixed in the same pass: `e2e/hydration.spec.ts`'s "adding a track does
not rebuild" test was genuinely flaky (unrelated to the above, reproduced
against an unmodified checkout too) — `rebuildsEngine()` in `e2e/helpers.ts`
now waits for the initial mount's own rebuild-counter tick before capturing
its "before" snapshot, closing a real race in the harness itself. Verified
with 15 repeated runs, no flake.

### Phase 3 — IndexedDB persistence + initial-load rehydration (not started)

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

### Track selection (`selectedTrackId`) is split across three separate hooks

`selectedTrackId` (the getter) lives on `PlaylistStateContextValue`, returned
by **`usePlaylistState()`** — not `usePlaylistData()` and not
`usePlaylistControls()`, despite how naturally either of those names reads for
"give me the selected track." `setSelectedTrackId` (the setter) is a third,
correct home: `PlaylistControlsContextValue`, via `usePlaylistControls()`.
Confirmed directly against `@waveform-playlist/browser/dist/index.d.ts`. Got
this wrong once already (`EditorShell.tsx` destructured `selectedTrackId` from
`usePlaylistData()`, which doesn't have it — `tracks`/`isReady`/
`timeScaleHeight` all do, which is presumably why it seemed like the right
hook) — a `tsc --noEmit` on this repo will always catch it (`TS2339`) if it
regresses, since there's no test suite to catch it otherwise.

Related, separate bug from the same fix: `EditorShell.tsx` maintains a
"sticky" ref (`activeTrackIdRef`) that always holds the last non-null
`selectedTrackId`, read later by `TransportControls`' upload handler at
file-dialog-close time (after the browser has already cleared focus/selection
state). The ref update was originally written directly in the component body
(`activeTrackIdRef.current = effectiveTrackId`) — React disallows mutating a
ref's `.current` during render (it throws: "Cannot access refs during
render"), so this must live inside a `useEffect` keyed on `effectiveTrackId`,
not inline in the render body.

**Correction to `EditorShell.tsx`'s own click-detection comment**: it claims
"the library's built-in track controls never call `setSelectedTrackId` when
the user clicks a track." That's only true for the left-hand controls column
(mute/solo/track-name sidebar, `controlsWidth`) — confirmed by reading
`@waveform-playlist/ui-components`'s `Playlist` component: `ControlsColumn` is
a plain sibling with no click wiring at all. The **right-hand scrollable
waveform/clips area** already has its own `ClickOverlay` wired to
`onTracksMouseDown`, which resolves the clicked row via the same
"cumulative track height" math (`peaksDataArray`/`waveHeight`/
`showClipHeaders ? 22 : 0`) and calls `setSelectedTrackId` itself — confirmed
in `@waveform-playlist/browser/dist/index.js`'s `handleMouseDown`/`selectTrack`.
So `EditorShell.tsx`'s manual `handleWaveformPointerDown` is only load-bearing
for clicks in the left controls column; for clicks in the waveform area it's
running redundantly alongside the library's own (already-correct, assuming
the two row-height computations agree) selection. Worth simplifying to only
handle the controls-column case before trusting this long-term — not done as
part of this pass since it works today.

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
exported, and was originally reused directly here for collision-safety (same
math `engine.moveClip()` uses internally, just applied to a track/position
the clip isn't natively being moved through the engine for). It no longer is
— `resolveDropPosition` dropped that call entirely once free clip overlap
became the intended behavior; see "Superseded issue" further down. The rest
of this section (cross-track target detection, `TRACK_ROW_HEIGHT_PX`) is
still accurate and unaffected by that change.

### Every accepted clip move forces a full engine rebuild — and `play()` can race it (FIXED)

`ClipDragLayer.tsx` applies every accepted drop — same-track slide *and*
cross-track — via `onTracksChange` directly (see "Clip dragging" above;
there's no `engine.moveClip()` cross-track primitive, and this file discards
the engine's own in-flight transaction on every commit via
`playoutRef.current?.abortTransaction()`, not just cross-track ones). Inside
`WaveformPlaylistProvider`, the tracks array this produces always fails the
`tracks === engineTracksRef.current` identity check, so the provider can't
treat it as an engine-originated update; it falls through to the **full
rebuild** branch — dispose the whole Tone.js engine/adapter and reconstruct
it for every track and clip, not just the moved one. This is broader than it
first looks: **any** completed clip drag is a rebuild trigger, not only
cross-track ones. For a large playlist (confirmed with 7 tracks / ~65 min of
real audio) this rebuild is slow enough to click through.

While it's in flight, nothing in the library stops you from pressing Play:
`PlayButton` only disables on `isPlaying`, never on rebuild-in-progress, and
the provider's own `play()` (confirmed by reading
`@waveform-playlist/browser`'s dist source directly, `dist/index.js:2638`)
has a check-then-act race —
`if (!audioInitializedRef.current) { await engineRef.current.init(); }
engineRef.current.play(...)`. If the rebuild's `engineRef.current = newEngine`
swap lands during that `await`, `init()` resolved against the *old* engine
but `play()` fires on the *new* one, whose underlying `TonePlayout` was never
initialized. Result: an uncaught
`Error: [waveform-playlist] TonePlayout not initialized. Call init() first.`
thrown from `TonePlayout.ts:197`. Reproduced by: several trims (fine, no
rebuild — trims commit via `engine.trimClip()` on the same engine instance),
one cross-track move, then pressing Play before the rebuild's `isReady` flip
completed.

Not fixable from application code (the race is inside bundled/minified
vendor output — a `patch-package` fix would be fragile against every future
version bump, since dist output isn't stable source), so the *trigger
window* is closed from two directions instead:

1. `EditorShell.tsx` wraps `<TransportControls>` in a `pointer-events-none` +
   `opacity-50` guard while `!isReady` (unchanged) — blocks Play for the
   duration of any full rebuild.
2. The residual gap this left — a user starts a *new* drag while an
   already-in-flight `play()` call is mid-`await` on `init()`, since
   `isReady` is still `true` at that point (the rebuild hasn't started yet) —
   is now closed by `transport/PlayButton.tsx`, a replacement for the
   library's own `PlayButton` that flags a shared `playPendingRef` for the
   duration of its `play()` call. `ClipDragLayer.tsx`'s `onDragEnd` checks
   this ref and, if set, treats the drop the same as a cancelled drag
   (delegates to the library's own handler instead of committing via
   `onTracksChange`) — refusing to trigger a rebuild while a `play()` call
   might still resolve against the engine that's about to be replaced.

**Verification note**: this exact race could not be forced to reproduce in
an automated Playwright harness even with the guard temporarily disabled
(confirmed A/B, 10 throttled attempts each way — see
`.claude/skills/verify/SKILL.md`). `AudioContext.resume()` latency isn't
proportionally slowed by CPU throttling the way JS execution is, and the
original discovery only happened against a real ~65-minute/7-track session.
The fix is correct by inspection (the ref flips synchronously around the
`await`, checked synchronously in `onDragEnd`) and introduces no regression
to normal playback or dragging, but treat "closes the race" as unverified at
runtime, not proven.

### A second, unrelated instance of the same race — editing *while already playing* (FIXED)

Distinct from the one above and much easier to hit: the `playPendingRef`
guard only covers a *new* `play()` call racing an in-flight rebuild. It does
nothing once playback is already underway (`playPendingRef.current` is
`false` again by then — `PlayButton.tsx` clears it in its `finally` block as
soon as `play()` resolves). Dragging a clip while audio is actively playing
was reproducible **100% of the time**, no throttling or timing luck needed
(confirmed via Playwright, both a direct repro and an A/B with the fix
reverted): `console.warn("[waveform-playlist] adapter.play() called but no
playout is available...")` during the drag, then every subsequent Play click
throws the same `TonePlayout not initialized` permanently — the app is stuck
until reload, matching the user-reported "it kind of crashes."

Root cause, confirmed by reading `@waveform-playlist/browser`'s dist source
directly (`dist/index.js` around the `wasPlaying`/`pendingResumeRef`/
`resumePlayback` effect, ~line 2177 and ~line 2615): the provider has its
*own* internal "auto-resume playback across a rebuild" mechanism, entirely
separate from `PlayButton.tsx`/`playPendingRef`. When a rebuild starts while
`isPlayingRef.current` is `true`, it stops the old engine and stashes
`pendingResumeRef.current = { position }` for a **separate** effect (keyed on
the same `tracks` dependency) to pick up and resume on the new engine once
built. But that separate effect runs synchronously, in the same commit,
immediately after the rebuild effect kicks off `loadAudio()` (an
unawaited async function) — and everything in `loadAudio()` up to its first
real `await` (disposing the old engine, resetting
`audioInitializedRef.current = false`) runs synchronously before that. So
`resumePlayback()` sees `engineRef.current` still pointing at the just-disposed
old engine, calls `.init()` on *that*, wrongly marks
`audioInitializedRef.current = true`, and by the time the *actual* new engine
is later assigned to `engineRef.current`, the app believes it's already
initialized when it never was — every future `play()` skips `init()` and
fails identically, forever.

Not patchable inside the vendored bundle for the same reasons as above, so
the fix again closes the *trigger* rather than the internals: `ClipDragLayer.tsx`'s
`onDragEnd` now calls `stop()` (from `usePlaylistControls`) before committing
any move while `usePlaybackAnimation().isPlaying` is `true`. `stop()` is
fully synchronous (confirmed by reading its source — no `await` at all), so
it batches into the same React commit as the `onTracksChange` that follows,
and by the time the provider's rebuild effect reads `isPlayingRef.current` it
already sees `false` — `pendingResumeRef` never gets armed, and the buggy
`resumePlayback` path never runs at all. Deliberate UX consequence: editing a
clip while playing now stops playback (same as most DAWs), rather than
silently continuing on a corrupted engine.

**Verification**: confirmed fixed via Playwright, both directly (play → drag
mid-playback → play again, repeated twice, zero errors) and via A/B with the
fix reverted (reliably reproduces both the mid-drag warning and the
permanently-disabled Play button afterward).

## Verification approach (no permanent test suite)

**Partially superseded**: the persistence/undo-redo layer now has a real
committed Playwright suite (`e2e/`, `npm run test:e2e`) — see "Persistence +
Undo/Redo layer" above. Everything else in this section still applies to the
rest of the app, which doesn't have committed coverage yet.

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

## Superseded issue — clip reorder-past-a-neighbor drag (RESOLVED, by design change)

This section used to track a bug where dragging a clip past an earlier
neighbor would snap back instead of reordering, root-caused to
`constrainClipDrag`'s collision math only allowing a reorder once the dragged
clip's *entire* width cleared the neighbor. A swap-on-center-crossing fix
(`resolveSameTrackMove`) was drafted but never implemented.

That whole approach is now moot: `resolveDropPosition` in `ClipDragLayer.tsx`
no longer does any neighbor/collision math at all. Clips can be dropped
anywhere, including fully overlapping another clip on the same track or a
different one — this is an intentional product decision (smooth "place a clip
wherever you want" UX), not a regression to fix. See `resolveDropPosition`'s
and `ClipDragLayer`'s own doc comments for the reasoning, and "Known
limitations" below for the trade-offs this brings.

## Known limitations (disclosed, not silently accepted)

- **Clip overlap is unconstrained by design** — dragging a clip (same-track or
  cross-track) never blocks or clamps against a neighbor; it can land fully on
  top of another clip. This is intentional (see "Superseded issue" above), not
  a bug, but it has real trade-offs: (1) a fully-covered clip becomes
  unclickable/untrimmable until the covering clip is moved away again (the
  dropped clip is always appended last to its track's array, so it renders on
  top and intercepts pointer events); (2) boundary trims still go through the
  library's own untouched `engine.trimClip()`/`constrainBoundaryTrim`, which
  computes its allowed range assuming the nearest sorted neighbor isn't
  already overlapping — trimming a clip that's already overlapping another can
  produce a smaller-than-dragged result (clamped by `minDuration` first). No
  crash or corrupted state in either case, just unintuitive in that specific
  combination.
- No undo/redo wiring for clip moves. Correction to an earlier note here:
  this applies to *every* accepted drop, not just reorders/cross-track —
  `onDragEnd` discards the engine's own in-flight transaction
  (`playoutRef.current?.abortTransaction()`) and commits via
  `onTracksChange` unconditionally (confirmed by reading the current
  `ClipDragLayer.tsx`), so same-track slides never go through
  `engine.moveClip()`'s transaction system either, despite what this section
  previously said.
- Memory: full Tone.js decode per clip, all resident simultaneously. Scale
  testing so far (15 tracks × 8 short synthetic clips = 120 clips) validated
  *structural/rendering* scalability, not real memory footprint at ~1hr of
  actual audio content — that's the next thing to stress-test for real
  before trusting this architecture at production scale.
