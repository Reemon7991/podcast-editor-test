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
the concrete gaps still open. Persistence, undo/redo, fade in/out, export,
text-to-speech, and silence removal are all done (see the persistence/
undo-redo layer section, "Fade in/out", "Export", "Text-to-Speech (Cartesia)",
and "Silence removal" below), each with a committed test suite. On top of
those, a **word-level transcription pipeline (Whisper via OpenRouter) and
audio search are now also done** (see "Transcription pipeline + Audio search"
below) — verified live against a real production build at every phase, but
**not yet covered by a committed Playwright suite** (ad-hoc scratchpad
verification only, same discipline the rest of this file used before the
persistence/undo-redo layer's suite existed — see "Verification approach").
**Filler-word removal — the other feature this transcription pipeline was
built for — has not been started yet.** Every non-obvious decision below
exists because of something concretely discovered while building this, not
speculation — treat this file as the fastest way to avoid re-deriving that
work in a future session.

## Current feature state

1. Single-file playback (load one audio file, waveform, play/pause, seek,
   zoom, scroll, time display) — done, verified.
2. Multi-clip single-track timeline (import multiple files via "Upload clip",
   inserted back-to-back starting at the current playhead position into the
   active track, pushed forward past an occupied spot instead of overlapping
   — see "Uploading onto an occupied playhead position no longer overlaps"
   below; play as one continuous timeline) — done, verified end-to-end.
3. Multi-track + clip dragging (multiple tracks, drag clips horizontally
   within a track, drag clips vertically to another track) — drops are
   blocked from overlapping a neighbor; a same-track drop where the pointer
   lands directly on one immediate neighbor offers a swap via a confirmation
   popover instead of blocking (see "Clip swap confirmation" below) —
   implemented; remaining known issues tracked in
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
   a reload. **Done** — see "Persistence + Undo/Redo layer" below for the
   actual design; don't treat this bullet as current truth, it's only kept
   here for the ordering rationale in the paragraph above.
2. **Undo/redo** — the library's own `WaveformPlaylistProvider` context
   already exposes `undo`/`redo`/`canUndo`/`canRedo` (confirmed in
   `@waveform-playlist/browser`'s public `.d.ts`), but those only cover
   engine-driven transactions, which is why this needs its own command/history
   layer independent of the library's internal one. **Done** — see
   "Persistence + Undo/Redo layer" below for the actual design (superseded
   the sketch this bullet used to contain) and the real bugs found building it.
3. **Export** — render the mixdown (all tracks/clips/gains) to an audio file
   the user can download. **Done** — see "Export" below for the actual
   design (it's not the hand-rolled `OfflineAudioContext` mixdown this bullet
   originally implied — the library already ships one) and a real bug found
   in the library's own solo/mute export logic along the way.
4. **Split and fade in / fade out** — clip-level editing beyond move/trim.
   Split was already done before this bullet was last updated
   (`useScissorsSplit.ts` + `ClipActionsOverlay.tsx`'s "Split" menu item).
   **Fade in/out is now done too** — see "Fade in/out" below for the actual
   design, including why every committed fade edit forces a full engine
   rebuild (no engine-native fade primitive exists, unlike trim) and the
   real bugs found building it.
5. **Audio effects** — per-clip or per-track processing (EQ, compression,
   gain automation, etc. — scope not yet defined).
6. **AI features** — text-to-speech, noise removal, humming removal, silence
   removal, transcription/search, filler-word removal. Scope, model/service
   choice, and where the compute runs are mostly open per-feature (not a
   blanket "needs a server" — see below), except for TTS: **done** (Cartesia,
   backend-owned request via a Next.js Route Handler, triggered from a
   "+ Clip" toolbar dropdown, inserted at the playhead through the existing
   upload clip-insertion pipeline) — see "Text-to-Speech (Cartesia)" below for
   the actual implementation and the real bugs found building it;
   `TTS_CARTESIA_PLAN.md` is the original design doc, kept corrected (not left
   stale) against what actually shipped. Silence removal: **done**
   (energy/RMS-based, fully client-side — no server round trip needed for
   this one, unlike the blanket note above originally assumed) — see
   "Silence removal" below for the actual implementation and the real bugs
   found building and then actually using it; `SILENCE_REMOVAL_PLAN.md` is
   the original design doc, kept corrected against what actually shipped,
   same discipline as `TTS_CARTESIA_PLAN.md`. Word-level transcription
   (Whisper via OpenRouter, backend-owned like TTS) and audio search built on
   top of it: **done** — see "Transcription pipeline + Audio search" below;
   `TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md` is the original design doc for
   both this and the still-open item below, same "kept corrected" discipline.
   **Filler-word removal is the one AI feature still not started** — the
   transcription pipeline it depends on is done and its own plan doc already
   spells out the intended design (per-clip menu item, disabled until that
   clip's transcript is ready, a review-then-apply modal rather than
   silence-removal's blind auto-apply — deliberately, since word-dictionary
   matching has real false positives RMS-based silence detection never had).
   Noise/humming removal remain fully open, no design work done.

## Architecture

**This tree predates several UI reorganizations** (a "UI-UX-redesign pass" —
`TransportControls.tsx` split into `layout/TopBar.tsx` + `transport/
BottomBar.tsx`, `ClipActionsToolbar.tsx`, `timeline/AddClipsDropZone.tsx`, a
`components/ui/` folder for generic primitives — referenced in passing by
`e2e/helpers.ts`'s own selector comments) and now also the Text-to-Speech
feature further down, neither reflected here. Left as-is rather than
rewritten in full as part of an unrelated change — the "Text-to-Speech
(Cartesia)" section below lists that feature's actual current files; check
the real `src/components/` tree directly for anything else not shown below.

```text
src/
  app/
    page.tsx                                server component, renders PodcastEditorLoader
    api/tts/route.ts                        Cartesia TTS — see "Text-to-Speech (Cartesia)" below
  components/
    PodcastEditorLoader.tsx                next/dynamic(ssr:false) wrapper — REQUIRED, see below
    PodcastEditor.tsx                      top-level state owner: useTimelineTracks; threads addTrack/addFilesToTrack down to TimelineStage
    timeline/
      TimelineStage.tsx                    wraps WaveformPlaylistProvider (tracks, onTracksChange, controls)
      EditorShell.tsx                      TransportControls + "New Track" button + ClipDragLayer(<Waveform showClipHeaders/>); also does manual track-click selection (see "Track selection" below)
      ClipDragLayer.tsx                    custom drag interaction layer — see "Clip dragging" below
      ClipSwapConfirmPopover.tsx           same-track swap confirmation — see "Clip swap confirmation" below
    transport/
      TransportControls.tsx                PlayButton/PauseButton/ZoomIn/ZoomOut (library components) + time + "Upload clip" file input + UndoRedoButtons (see "Persistence + Undo/Redo layer" below)
      PlaybackTime.tsx                     live time display, registerFrameCallback-driven (NOT React state)
      DurationLabel.tsx                    total duration display
    clip-menu/
      ClipActionsOverlay.tsx               per-clip "..." menu (split/duplicate/delete) AND fade-in/fade-out handles, positioned over whichever clip the pointer is on — see "Fade in/out" below
      ClipActionsMenu.tsx                  generic "..." trigger + dropdown, reusable beyond clips
      FadeHandles.tsx                      draggable fade-in/fade-out circles — see "Fade in/out" below
  hooks/
    useTimelineTracks.ts                   tracks[] as persisted state; addTrack/removeTrack/addFilesToTrack(trackId, files, insertionTimeSeconds)
    useClipActions.ts                      duplicate/delete clip mutations
    useScissorsSplit.ts                    "click a clip to choose a split point" mode
    useFadeDragHandlers.ts                 fade-handle drag mechanics — see "Fade in/out" below
  utils/
    trackLayout.ts                         TRACK_WAVE_HEIGHT + TRACK_ROW_HEIGHT_PX (empirically measured)
    clipGeometry.ts                        pixel↔sample hit-testing shared by ClipActionsOverlay/useScissorsSplit/ClipDragLayer; also resolveNonOverlappingStart, the shared collision-avoidance math for both uploads (useTimelineTracks.ts) and drag/drop (ClipDragLayer.tsx)
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

## Persistence + Undo/Redo layer (undo/redo and persistence both done)

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

### Post-Phase-2 fix: redo corruption after undoing track add/remove sequences (FIXED)

`undo()`/`redo()` handed back `entry.before`/`entry.after` directly, preserving
track object references. That satisfied the library's incremental-add
fast-path (which only checks that old track objects still exist *somewhere* in
the new array, not at the same *position* — its `engine.addTrack()` remedy
always appends to the end) even when a removed track was being restored to
the *middle* of the array rather than the end. The library still appended it
at the end instead, and mirrored that reordered mismatch back as a spurious
history entry that silently wiped `future` — breaking redo partway through a
mixed undo/redo sequence involving add/remove track. Fixed by cloning every
track object in `undo`/`redo` (`store/projectStore.ts`'s `cloneTracks`),
deliberately breaking reference equality to force a full rebuild (always
safe) instead of the position-blind incremental path. Not needed in
`commit`/`commitEngineOutput` — only undo/redo can reintroduce a track at a
non-end position.

### Phase 3 — IndexedDB persistence + initial-load rehydration (done)

`idb` (thin Promise wrapper over IndexedDB, not `localforage` — no need for
its legacy storage-fallback layer) backs `utils/persistence.ts`: DB
`editor-pro` v1, two stores. `project` holds a single fixed-key record
(`{ schemaVersion, tracks: TrackMeta[], updatedAt }`) — only the current
`present` snapshot, never `past`/`future` (undo history doesn't need to
survive a reload). `assets` holds the original uploaded `File`/`Blob` (not the
decoded `AudioBuffer` — no cheap re-encode path back to a file), keyed by the
same content-hash `assetId` from Phase 1, so a repeat upload of identical
bytes is an idempotent overwrite, not a duplicate — cross-upload dedup is a
property of the key, no extra logic needed. `getDb()`'s `openDB()` call is
lazy (first actual use, inside an effect), never at module scope — confirmed
`idb` itself doesn't touch `window`/`indexedDB` at import time either, but
deferring costs nothing and the plan's own gotcha here didn't need to be
relied on: `persistence.ts` is only ever reached through `PodcastEditor.tsx`,
which is already behind `PodcastEditorLoader.tsx`'s `next/dynamic(ssr:false)`
boundary, so nothing in this chain is ever part of the server bundle at all.

`hooks/useProjectHydration.ts` — mount effect (guarded by a ref against
Strict Mode's dev-only double-invoke): `loadProject()` → collect every
distinct `assetId` referenced → `loadAssets()` (batched parallel read) →
decode each blob (`Tone.getContext().rawContext.decodeAudioData`) →
`registerAsset(buffer, assetId)` **using the persisted id** (minting a fresh
one here would orphan every `ClipMeta.assetId` already in the loaded tracks —
`assetRegistry.ts` never mints ids itself, by design since Phase 1, so this is
just a second caller of the same function with a different, non-hashed known
id) → `store.replacePresent(tracks)`. Wrapped in try/catch: any failure
(private-browsing storage block, quota error, a corrupt record) falls back to
the store's default single-empty-track project instead of surfacing an error.
One gap the original plan didn't spell out and this pass closed: a per-asset
decode failure or a genuinely missing blob (asset GC still isn't
implemented — see "Known limitations" — but the store could still be cleared
out-of-band) is handled one level more granularly than "fail the whole
hydration" — only the clips referencing the unresolved asset are dropped, so
one bad asset doesn't take down the whole reload.

`useTimelineTracks.ts`'s `addFilesToTrack` now also calls `saveAsset(assetId,
file)`, run concurrently with `decodeAudioData` via `Promise.all` (save
failure is logged and swallowed, not thrown — persistence degrading
gracefully shouldn't break an otherwise-successful import). `PodcastEditor.tsx`
mounts `useProjectHydration()`, renders a `"Loading project…"` placeholder
(same visual language as `PodcastEditorLoader.tsx`'s own loading state, for a
consistent two-stage load) in place of `TimelineStage` while hydrating — which
also means no user mutation can race `replacePresent`, since nothing is
interactive yet — and mounts a 500ms trailing-edge debounced `saveProject`
effect on `present`, armed only once hydration completes.

**Two things found while building this, worth not re-discovering:**

- **Every existing test's `waitForWaveformReady()` needed to learn about the
  new pre-mount loading stage.** It previously just waited for "Building
  waveform…" to hide; once hydration runs *before* `TimelineStage` (and that
  placeholder) ever mounts, that wait could resolve while still on the
  `"Loading project…"` screen (zero "Building waveform…" matches is trivially
  true there too) — then the test would go on to click controls that don't
  exist yet. Fixed once, in `e2e/helpers.ts`, so every spec benefits: wait for
  `"Loading project…"` hidden first, then `"Building waveform…"` hidden — safe
  in both cases even if a given placeholder never appears at all (hydration
  fast enough, or the very first build already done), same
  `waitFor({state:"hidden"})` property the original placeholder wait already
  relied on.
- **A raw `indexedDB.open()` call from a Playwright `page.evaluate()`,
  immediately after this app has fully loaded, intermittently stalls for 30s+
  before *any* of open/onsuccess/onerror ever fires** — reproduced repeatedly
  under `playwright test`'s worker-reused-browser-process + `--repeat-each`,
  never once across dozens of manual repros in a freshly-launched browser
  process outside the test runner (including with the app's own debounced
  save deliberately timed to be mid-flight). Reads as a Chromium/Windows-level
  IndexedDB connection-teardown timing quirk tied to how Playwright recycles
  contexts within one browser process — not a defect in `persistence.ts`/
  `useProjectHydration.ts`, both of which are exercised (via the app's own
  `idb` calls, not a bypassing raw connection) by the round-trip and dedup
  tests below and passed reliably in every run. Only one committed test needs
  a raw connection at all (to corrupt a record out-of-band); it's isolated in
  its own `describe` with `retries: 2` and a doc comment disclosing this,
  same treatment as the two playback-guard races elsewhere in this file that
  are correct by inspection but not reliably provable under Playwright timing.
  Navigating to a same-origin 404 route before opening the raw connection
  (tearing down `useProjectHydration.ts`'s own long-lived connection first)
  measurably reduces how often this hits but doesn't eliminate it.

Committed coverage (`e2e/persistence.spec.ts`, 4 tests): a fresh IndexedDB
still renders the default empty project without hanging; import → trim →
reload restores the same clip and playback still works against the
re-decoded buffer; a corrupt persisted record falls back to the default
project instead of hanging (the try/catch path above); uploading the same
file twice writes exactly one `assets` record (the cross-upload dedup case
Phase 1 deferred here, now actually observable end-to-end) and both clips
still resolve correctly after a reload. Full suite (22 tests: this file plus
`hydration.spec.ts`, `playback.spec.ts`, `undoRedo.spec.ts`) passed repeatedly
against a fresh prod build.

Not built (disclosed, matches the original plan's "not in scope"): asset
garbage collection, multi-tab sync, persisting undo history itself.

### Post-Phase-3 perf regression: trimming got heavier on large sessions (FIXED, measured)

Reported after Phase 3 landed: trimming felt noticeably heavier than before
this whole layer existed, specifically on this app's actual target (2-3 hour
podcasts, many tracks/clips) — not reproducible on the small 1-2 clip
sessions used to verify Phases 1-3, which is exactly why it wasn't caught
earlier. Two distinct causes, found by reading the library's own drag-move
implementation directly (`@waveform-playlist/browser/dist/index.js`'s
`onDragMove`), each independently confirmed by measurement (not just code
review) before being written up here:

- **`dehydrate()` was re-processing every clip in the whole session on every
  pointer-move frame of every trim drag**, not just the one clip actually
  changing. `ClipDragLayer.tsx`'s live-preview path
  (`updateEngineOutputLive`) calls `dehydrate(raw)` on each frame; confirmed
  in the library's `onDragMove` that a boundary (trim) drag rebuilds only the
  *one* track containing the trimmed clip each frame and returns every
  sibling track by the same object reference — the exact same reference-
  stability property Phase 1's `hydrate()` per-track cache already relies on,
  just never extended to `dehydrate()`. Fixed by adding the same per-track
  `WeakMap` memoization to `dehydrate()` (`utils/clipHydration.ts`'s
  `dehydratedTrackCache`). Only affects trim — the one gesture with a
  live-preview dehydrate path (the library's own `onDragMove` bails out early
  for non-boundary drags, confirmed by reading it) — plain clip moves commit
  once at drag-end with no per-frame cost, matching that this was reported
  specifically for trimming, not dragging.
- **A regression in Phase 3's own code**: `PodcastEditor.tsx`'s debounced
  auto-save effect depended on `present` directly, which changes on every one
  of those same live-preview frames — a trim paused for 500ms+ mid-gesture
  could trigger a full-session IndexedDB write mid-drag. Fixed by keying the
  effect on `past` (undo history) instead: `past` only changes on a real
  history-pushing commit (`commit`/`commitEngineOutput`/`undo`/`redo`), never
  on `updateEngineOutputLive`, so the debounce no longer re-arms during a live
  drag at all — it fires once, after the gesture settles.

**Measured, not just reasoned about**: temporarily instrumented
`dehydrateClip` with a call counter, built an 8-track × 6-clip (47 total
clips) synthetic session via the real upload UI, and drove one trim gesture
with the same `page.mouse.move({steps})` pattern the committed drag tests
use. With the fix: **306 total `dehydrateClip` calls across the drag, ~6.8
per frame** — matching the trimmed track's own 6 clips. With the fix
reverted (same session, same drag): **2112 calls, ~46.9 per frame** —
matching the whole 47-clip session. Confirms the fix and quantifies it: ~7x
fewer clip-object rebuilds per frame at this session size, a ratio that
widens with track count for the app's actual target of much larger
real-world sessions. Instrumentation was temporary (added, measured against
both the fixed and reverted code, then fully removed) — not committed.

Audited for other instances of the same class of bug (something scaling with
whole-session size on a per-frame or per-render basis) and found none:
`hydrate()`'s own per-render call in `TimelineStage.tsx` was already
per-track memoized since Phase 1; `deepEqual`/`cloneTracks`/history array
copies in `projectStore.ts` all run once per *settled* commit, never per
drag frame; `useScissorsSplit.ts`'s preview line is local component state
that never touches the store; plain clip moves have no live-preview path at
all (confirmed above); `saveProject` only serializes small JSON-safe
metadata (no audio) and, after the fix above, only runs once per settled
commit.

Also fixed in the same pass, found only because it started producing
thousands of lines of noise once a local `playwright-report/` existed on
disk: `eslint.config.mjs`'s `globalIgnores` didn't exclude
`playwright-report/**`/`test-results/**` (both already gitignored, but
ESLint doesn't consult `.gitignore` on its own) — a bare `eslint .` after
running the suite locally would lint Playwright's own minified report/trace
assets. Added both to `globalIgnores` alongside the existing `.next/**`
entry.

Verified: full suite (22 tests) passed against a fresh prod build with both
fixes in place (and separately, unmodified, against the reverted-fix
baseline used for the measurement above, to confirm the baseline itself
wasn't somehow already broken).

### Post-Phase-3 review follow-ups (FIXED)

A follow-up review of the Phase 3 + perf-fix code (not a new bug report,
a deliberate re-check of "is this actually well implemented") found two
more issues, both fixed in the same pass:

- **The debounced save effect fired once, redundantly, after every single
  app load.** `PodcastEditor.tsx`'s save effect is keyed on
  `[past, isProjectHydrating]` — `isProjectHydrating` flipping false is
  itself a dependency change, so the effect re-runs at exactly the moment
  it stops early-returning, arming a save 500ms later regardless of whether
  the user touched anything. On a fresh IndexedDB this created a `project`
  record purely from opening the app once. Fixed with a `skipNextSaveRef`
  ref (starts `true`, cleared the first time the effect runs post-hydration)
  that skips exactly that one occurrence; any later real `past` change still
  saves normally.
- **A failed asset persist or a dropped-on-hydration clip was silent** —
  console-only, with nothing in the UI. Both are real possibilities at this
  app's actual target scale (2-3 hour podcasts, large asset blobs — real
  storage-quota territory), and both meant a user could lose actual edited
  work across a reload with zero indication anything went wrong.
  `useTimelineTracks.ts`'s `addFilesToTrack` now counts `saveAsset` failures
  per import batch and exposes `saveWarning`; `useProjectHydration.ts` counts
  clips dropped for a missing/undecodable asset and exposes
  `hydrationWarning`. `PodcastEditor.tsx` renders either as a dismissible
  amber banner (`WarningBanner`) — same "surface it, don't just
  console.warn" precedent `TimelineStage.tsx`'s red `providerError` banner
  already established for a harder failure.

Verified: `tsc --noEmit` and `eslint` clean; full suite (22 tests) passed
against a fresh prod build (one pre-existing flaky retry on the corrupt-record
test — the already-documented raw-`indexedDB.open()`-under-Playwright timing
quirk two sections up, unrelated to this change, isolated in its own
`describe` with `retries: 2`).

### Post-Phase-3 fix: mute/solo/volume/pan never persisted, and scrambled after add/remove-track (FIXED)

User-reported, two symptoms sharing one root cause: (1) track mute/solo/
volume/pan weren't reliably surviving a reload; (2) muting track 2 and
soloing track 3, then adding and deleting a 4th track, could leave both
tracks' settings wrong — reset, or bled onto each other.

**Root cause, confirmed by reading `@waveform-playlist/engine`/`browser`'s
dist source directly**: `PlaylistEngine.setTrackMute/Solo/Volume/Pan` mutate
the engine's own `_tracks` in place but only bump `mixerVersion`, never
`tracksVersion` (by design — a volume drag shouldn't force a rebuild).
`WaveformPlaylistProvider` mirrors this into its own React-local
`trackStates` (index-parallel to its `tracks` prop) but never folds it back
into `onTracksChange`, since that's gated on `tracksVersion` too — confirms
the "dead fields" limitation already documented above is still true in the
currently-installed version. `present` never learns about a mixer click at
all; `TrackMeta.muted/soloed/volume/pan` stay at track-creation defaults
forever. That alone explains bug 1. Bug 2 is a *second*, vendor-side defect
on top: `loadAudio()` (the full-rebuild path, always taken on track
removal) reconciles `trackStates` purely by **length**, never by track id —
a length mismatch discards it and reseeds from the incoming (stale-default)
`ClipTrack.muted/soloed/...`, so settings vanish; a length match keeps the
old `trackStates[i]` entries as-is and just relabels `.name`, silently
re-pairing whatever mixer values existed at each *position* with whichever
track now sits there after removal shifted indices — settings bleed onto
the wrong track.

**Fix** (`store/projectStore.ts`, `components/timeline/EditorShell.tsx`,
`components/PodcastEditor.tsx`): bridges the library's live `trackStates`
out of the provider's context via a module-level registry
(`registerLiveMixerState`/`withLiveMixerState`, same pattern `stopIfPlaying`
already established for this exact problem). `withLiveMixerState` merges
live values onto a `TrackMeta[]` snapshot by id, preserving object identity
where nothing changed — called from `commit()` (every structural edit now
carries forward live mixer state, which is also what fixes bug 2 — it
always feeds correct values into whichever vendor reconciliation branch
fires) and from `commitEngineOutput()` (so undo doesn't revert to a stale
mixer value if a trim/split/move is the first engine-driven update since a
live mixer change). A `mixerTouchVersion` counter, bumped from
`EditorShell.tsx` when live mixer state actually changes, re-arms
`PodcastEditor.tsx`'s debounced save for a session that ends on a pure
mixer toggle — mixer edits never touch `past`, so the existing
`past`-keyed save effect alone would miss that case.

**Two real bugs caught in self-review, not by a test**:

- Subscribing to `mixerTouchVersion` reactively
  (`useProjectStore((s) => s.mixerTouchVersion)`) in `PodcastEditor.tsx`
  made it re-render on every mixer click, cascading into the non-memoized
  `TimelineStage.tsx` — whose `hydrate(tracks)` call always returns a *new*
  top-level array even when every track is cache-identical. The provider's
  reconciliation effect has no "did `tracks` really change" check beyond
  reference identity, so this forced a full engine rebuild on every mixer
  click. Caught by `e2e/hydration.spec.ts`'s "adding a track does not
  rebuild the engine" failing; confirmed as a genuine regression (not a
  pre-existing flake) via `git stash` against the unmodified baseline.
  Fixed by subscribing imperatively (`useProjectStore.subscribe`) instead,
  which never triggers a React re-render.
- `EditorShell.tsx`'s live-mixer-state effect originally had no dependency
  array, rerunning on every render — including every trim-preview
  pointer-move frame, the app's hottest path (see the perf regression
  above). Fixed by keying it on `trackStates` alone: that array only gets a
  new reference on a real mixer edit or track add/remove, never a
  clip-level edit.

Verified: `tsc --noEmit`/`eslint` clean; full suite (49 tests) passed
against a fresh prod build, re-run after the regression fix and again after
the perf fix; three scripted real-browser checks (playwright-core, same
discipline as "Verification approach" below) covering both reported
scenarios end-to-end (mute+solo survive a reload; survive an add+delete of
a 4th track; both together survive a reload) plus the undo edge case (mute
a track, trim — the first engine-driven edit since the mute — undo once,
mute is still on).

Not built (disclosed): mute/solo/volume/pan are still not separate
undo/redo steps — a live mixer change gets silently folded into whichever
next real edit's history entry, the same treatment trim's live-preview
frames already got in Phase 2 ("Trim's live-preview frames were flooding
undo history"). A deliberate default, not something requested; revisit if
a future session wants mixer changes itemized in the undo stack.

## Fade in/out (done)

Small draggable circle handles at each clip's fade corners — drag inward/
outward to set fade-in/fade-out duration. Built after a UX-alignment pass
with the user (drag handles, not a menu; one fixed curve shape for v1;
hover-revealed) and a verification pass against the actual
`@waveform-playlist/*` vendor source, same discipline as every other feature
in this file.

**The one finding that shapes the whole design**: `@waveform-playlist/engine`'s
public API only exposes `splitClip`/`trimClip`/`moveClip` — no engine-native
fade primitive exists (confirmed by reading its `.d.ts`). The provider's
rebuild-avoidance check (`browser/dist/index.js`, see "Confirmed library
behavior" above for the exact logic) only skips a full Tone.js dispose+rebuild
when `tracks === engineTracksRef.current` (true only right after a real
`engine.trimClip()` + `commitTransaction()`) or while `isDraggingRef.current`
is true (true only during the library's own boundary-drag gesture). A fade
edit is neither — it's a hand-built `ClipTrack[]`, exactly like a completed
clip **move** — so **every committed fade edit forces one full engine
rebuild**, the same "Building waveform…" flash a move already causes. Not
fixable by faking `isDraggingRef` to suppress the rebuild: that would leave
the live Tone.js engine still playing the *old* fade values with no way to
tell it otherwise — a worse, silent bug than the rebuild cost. Confirmed this
isn't an accidental slowdown, not just reasoned about: a direct measurement
(`page.mouse` drag + `waveform-playlist:ready` timing, small single-clip
session) showed a fade commit's rebuild at **68ms**, actually *faster* than a
plain clip move's **337ms** in the same run — the cost is the same class as
every other non-engine-native mutation already has, proportional to session
size, not something fade-specific to optimize away.

That one fact also rules out reusing trim's live-preview store machinery
(`updateEngineOutputLive`/`dragBaseline`): routing every mousemove through
the store would put a fresh, non-rebuild-avoidable tracks array in front of
the provider on *every frame* — far worse than one rebuild per completed
gesture. So the drag's live preview is **entirely local hook state, never
touching `store/projectStore.ts`** — the real commit happens once, at
mouseup. No store changes were needed anywhere in this feature.

**Second vendor gotcha, found by reading both sides**: `@waveform-playlist/core`'s
own `Fade` type interface documents its default curve as `'linear'`, and
`@waveform-playlist/playout`'s `scheduleFades` defaults an omitted `type` to
`"linear"` — while `ui-components`' `FadeOverlay` (the curve-drawing
component) defaults to `"logarithmic"`. Leaving `type` unset on a created
`Fade` object would make the drawn curve and the audible envelope mismatch.
`useFadeDragHandlers.ts`'s `FADE_CURVE_TYPE` constant is always set
explicitly for exactly this reason — currently `"linear"` (the user's choice
after trying it; trivial to change later since it's one constant, and the
curve shape already round-trips through undo/redo and persistence untouched
since `ClipMeta` is `Omit<AudioClip, "audioBuffer">`).

**Files**:
- `hooks/useFadeDragHandlers.ts` — modeled on `useScissorsSplit.ts`'s shape
  (raw `window` mousemove/mouseup/keydown listeners, no `@dnd-kit`; fade-
  dragging is single-clip/single-axis with no cross-track or collision
  logic, so nothing is gained by joining `ClipDragLayer.tsx`'s already-
  complex dual-`DragDropProvider` machinery). On mouseup, mirrors
  `ClipDragLayer.tsx`'s `onDragEnd` move-commit ordering exactly (`flushSync`
  `stop()` if playing, then check `playPendingRef` before calling
  `onTracksChange`) — a fade commit reaches `commitEngineOutput` via the same
  unconditional-rebuild path a hand-applied move does, so `commit()`'s
  centralized `stopIfPlaying` guard never runs for it; it needs the same
  local guard `ClipDragLayer.tsx` already has.
- `components/clip-menu/FadeHandles.tsx` — presentational, portaled
  alongside the existing "…" button into the library's scroll container.
  Handle position tracks the live drag locally; the vendor's own
  `FadeOverlay` curve only updates once the drag commits and the rebuild
  completes (see "double overlay" bug below for why this file doesn't try to
  paper over that gap with its own preview shape).
- `components/clip-menu/ClipActionsOverlay.tsx` — reuses its existing hover-
  tracking (`active`/`activeTrack`/`activeClip`/`left`/`width`) rather than
  running a second `mousemove` listener; adds a sticky `fadeDragLockedFor`
  state (mirrors the existing `menuOpenFor` pattern) and a
  `handleFadeDragLockChange` wrapper (see "hover vanishes after Escape" bug
  below for why the latter is load-bearing, not cosmetic).
- `components/timeline/EditorShell.tsx` — `showFades` added to the existing
  `<Waveform>` call (one-line; `fadeIn`/`fadeOut`/`sampleRate` already flow
  per-clip through `<Waveform>`/`<Clip>` internally); `playPendingRef`
  threaded down into `<ClipActionsOverlay>` (new prop — the playback guard
  above now lives in that subtree).
- `app/globals.css` — a `[data-boundary-edge]::after` rule gives the
  existing (vendor-rendered, already hover-revealed but previously
  border-only) trim handles a more visible pill on hover. Pure CSS, no
  vendor JS touched: `ClipBoundary`'s styled-components CSS reads no `theme`
  prop (confirmed by reading its source, unlike `FadeOverlay`), so this was
  the only way to change its look without patch-package.
- No changes to `store/projectStore.ts` or `utils/clipHydration.ts` — both
  already generic enough (`commitEngineOutput` already fans in trim/split/
  move under one "Edit timeline" label with no special-casing; the per-track
  `WeakMap` hydrate/dehydrate caches benefit automatically as long as the
  commit's `tracks.map()` keeps every untouched sibling track by the same
  object reference, which `useFadeDragHandlers.ts` does).

**Real bugs found and fixed while building this** (each caught by actually
using the feature, not by review alone):

1. **`setState` called during another component's render.** The first
   version of `endDrag` read the live preview value via `setDragging`'s own
   updater-function `current` argument, then performed side effects
   (`flushSync(stop())`, `onTracksChange?.(...)` — which flows into a
   Zustand `set()` that updates `PodcastEditor`/`TimelineStage`) *inside*
   that updater callback. Updater functions must be pure; triggering another
   component's update from inside one produces exactly React's "Cannot
   update a component while rendering a different component" warning
   (reproduced once by an actual user of this app, after a fresh page load —
   React tolerates it outside Strict Mode, so it doesn't always warn, but it
   was a real latent bug). Fixed by mirroring the live value into
   `dragMetaRef.current.previewDurationSamples` (updated in `handleMouseMove`
   alongside the existing state update) so `endDrag` reads a plain ref value
   and runs its commit logic as an ordinary side effect, with `setDragging`
   reduced to a single, side-effect-free `setDragging(null)`.
2. **Escape-cancelling a fade drag left the "…" button and fade handles
   invisible until the next mouse movement.** `ClipActionsOverlay.tsx`'s own
   hover-tracking effect already nulls `hovered` for the whole gesture
   whenever `isDraggingRef.current` is true — a signal shared with trim/move
   drags, and now also set by `useFadeDragHandlers.ts`. Fine *during* the
   drag (`fadeDragLockedFor` keeps `active` pinned instead), but nothing
   naturally repopulates `hovered` once the drag ends unless a real
   mousemove happens afterward. Invisible for a *committed* fade (the
   resulting rebuild remounts the whole `ClipDragLayer`/`ClipActionsOverlay`
   subtree anyway, resetting all local state), but real for an
   Escape-cancelled one (no rebuild, so no remount to reset anything).
   Fixed: `handleFadeDragLockChange` restores `hovered` to the just-finished
   clip when the lock clears, instead of leaving both `null`.
3. **Two conflicting fade shapes visible at once when editing an
   already-faded clip.** An earlier version of `FadeHandles.tsx` also drew a
   local, translucent straight-line approximation of the fade region during
   the drag, for live curve feedback (the vendor's own `FadeOverlay` curve
   only updates post-commit — see the architecture note above). When the
   clip already had a fade set, that local wedge and the vendor's real
   (stale, pre-drag) curve were both visible simultaneously, at different
   widths — read as two separate, conflicting shapes rather than one
   smoothly updating one (reported directly by a user of this app). An
   opaque-masking version (cover the stale curve with a `var(--background)`
   box sized to the union of the old and live widths, draw the live wedge on
   top) was tried and worked, but was reverted at the user's request in
   favor of simplicity: **no custom preview shape at all** — the handle's
   own live position is the only in-drag feedback, and the real curve
   reappears (correctly, and alone) the instant the drag commits.

Committed coverage (`e2e/fades.spec.ts`, 6 tests, following
`hydration.spec.ts`/`undoRedo.spec.ts` conventions — real `page.mouse`
sequences, not `dragTo()`; new `fadeInHandle`/`fadeOutHandle` selectors in
`e2e/helpers.ts`): handles hidden by default, appear on hover; **dragging a
fade handle rebuilds the engine** (the key architectural assertion — pins
down the "always rebuilds, unlike trim" finding as a regression test, so a
future session can't silently "fix" this into a visual/audio mismatch the
way faking `isDraggingRef` would); a completed drag undoes in one step;
Escape cancels without committing; dragging back to the corner clears the
fade; the playback guard (drag while playing stops playback instead of
crashing, mirroring the existing move/duplicate/undo tests). Full suite (28
tests) passed repeatedly against a fresh prod build.

Not built (disclosed): per-clip curve-shape picker (fixed to linear for v1,
see the type-mismatch note above), any way to type an exact fade duration
(drag-only for v1).

## Export (done)

Full mixdown to a downloadable file, via an "Export" dropdown next to
"+ Clip" — WAV plus compressed MP3/AAC formats, see "Compressed export
(MP3/AAC)" below for the latter. Full plan: `.claude/plans/` history from the
session that built this — the short version below is what a future session
actually needs.

**Don't hand-roll an `OfflineAudioContext` mixdown** — `@waveform-playlist/
browser` already ships one, at the `@waveform-playlist/browser/tone` subpath
(not the main entry — easy to miss; this app's own dependency is already the
right version, no bump needed). `useExportWav()` returns `{ exportWav,
isExporting, progress, error }`; `exportWav(tracks, trackStates, options)`
builds an offline Tone render (per-clip `Player → gain/fade → track volume/
pan/mute → master → destination`, same shape as live playback) and hand-
encodes the result to a WAV `Blob`, triggering a real browser download.
Confirmed by reading `dist/tone.js` directly, not just the `.d.ts` — same
discipline as everywhere else in this file.

**Real bug found in the library's own export code**: `useExportWav`'s solo/
mute filter (`renderOffline`'s `audibleTracks` check) doesn't match
`TonePlayout.updateSoloMuting()`'s live-playback rule for one combination —
a track that's both `soloed: true` and `muted: true`. Live playback: silent
(soloing doesn't override a track's own mute). The library's export filter:
audible. `utils/audibleTracks.ts`'s `audibleIndices()` reimplements the
correct rule and pre-filters tracks before calling `exportWav`, always
passing `{ muted: false, soloed: false }` for whatever survives — so the
library's own filter never sees anything it could get wrong. Covered by an
e2e regression test (`e2e/export.spec.ts`, "soloing an already-muted track
still exports nothing").

**Bigger discovery, found while wiring this up**: mute/solo/volume/pan
button clicks *never reach this app's own state at all*. Confirmed by
reading `@waveform-playlist/browser/dist/index.js`: those edits only bump
the engine's internal `mixerVersion`, and `onTracksChange` (the only way
engine changes reach `TimelineStage.tsx`/the Zustand store) is gated on
`tracksVersion` instead — it never fires for mixer-only edits. The library
tracks live mixer state in its own separate `trackStates` React state
(exposed via `usePlaylistData().trackStates`), decoupled from the `tracks`
prop entirely. Net effect: `TrackMeta.muted`/`.soloed`/`.volume`/`.pan` in
`present` are dead fields — always whatever they were at track creation,
never updated by the UI. **Not fixed** (out of scope for export — this
predates it and likely also means mute/solo/volume/pan don't survive a
reload; see "Known limitations"). Export sidesteps it by reading
`usePlaylistData().tracks`/`.trackStates` directly (the live engine state)
instead of `present`, rather than trusting the app's own stale copy.

**No progress bar** — `useExportWav`'s `progress` value only fires at three
fixed checkpoints (0.1 at render start, 0.9 after render, 1.0 after encode),
not continuously (`OfflineAudioContext.render()` exposes no progress events).
A percentage sat visibly unmoving for the whole export, which read as a hang
rather than a working busy-state — tried once, reverted. The Export button
(inline in `components/layout/TopBar.tsx`, no dedicated `ExportButton.tsx`
component despite what an earlier pass of this file claimed — correcting
that here) just shows "Exporting…"/disabled, no number.

**Files**: `utils/audibleTracks.ts` (solo/mute rule above),
`hooks/useProjectExport.ts` (thin wrapper: filters via `audibleIndices`,
builds a `podcast-export-<timestamp>.wav`/`...-<format>kbps.<ext>` filename,
calls `exportWav`), the Export `MenuButton` in `components/layout/TopBar.tsx`,
wired through `EditorShell.tsx` the same way `playPendingRef`/
`activeTrackIdRef` already are. `EditorShell.tsx`'s existing rebuild-guard
div (disables the transport bar while `!isReady`) now also gates on
`isExporting` — an offline render temporarily swaps Tone's global context
(`setContext`/restored in `finally`), so editing or playing mid-export is
closed off the same way the two other Tone-context races in this file
already are, rather than relying on it being provably safe.

Committed coverage (`e2e/export.spec.ts`, 5 tests): download + duration
match the timeline, transport bar disables during export, muting the only
track surfaces an error instead of downloading silence, the soloed+muted
regression above, and a fade-in audibly ramping up in the exported PCM.
Full suite (33 tests) passed against a fresh prod build, plus a manual
real-browser pass (mute, solo, solo+mute, fade, busy-state, console-error
check) with a headless-Chromium script — all matched expectations, zero
console errors.

Not built (disclosed): per-track export (`exportWav`'s `mode: 'individual'`
exists and works, just not wired to any UI yet), 32-bit float output
(`bitDepth` option exists, defaulted to 16-bit).

### Compressed export (MP3/AAC) (done)

WAV's uncompressed PCM made exports much larger than users expected relative
to the (compressed) source files — a 5.7MB pair of source clips exported to
~113MB of WAV, which read as a bug report but is just what raw 16-bit PCM at
the live context's sample rate costs (roughly 15-20x a typical speech
bitrate). Rather than shrinking WAV itself, added real compressed
alternatives: the Export button (formerly a single-click WAV download) is now
a dropdown (`MenuButton`, same shape as "+ Clip") listing WAV first, then
MP3 · 64/128/160 kbps, then AAC · 128 kbps. Opus and FLAC were considered and
deliberately deferred to a later pass — the format list is a fixed array
(`utils/exportFormats.ts`'s `EXPORT_FORMAT_ORDER`), easy to extend once
wanted.

**Architecture — no duplicate mixdown.** Compressed formats reuse the exact
same render `useExportWav` already produces for WAV: `useProjectExport.ts`
calls `exportWav(audibleTracks, audibleStates, { ..., autoDownload: false })`
to get back `ExportResult.audioBuffer` (skipping the library's own WAV
download), then `utils/exportFormats.ts`'s `encodeCompressed()` re-encodes
that buffer via `mediabunny` — the identical `AudioBufferSource` → `Output` →
`BufferTarget` pattern `utils/audioCompression.ts`'s Opus encoder already
uses for the transcription pipeline, just pointed at `Mp3OutputFormat`/
`Mp4OutputFormat` and export-quality stereo bitrates instead of that file's
mono/16kHz/24kbps speech-to-text constants — the two encoders share a
library, not any constants or state. WAV's own render/download path is
otherwise untouched.

**Real finding, confirmed live, not assumed from docs**: MP3 encoding is
*not* guaranteed to be available via a browser's WebCodecs `AudioEncoder` the
way Opus/AAC broadly are — `mediabunny` supports MP3 as a container/codec
(`Mp3OutputFormat`, and its bitrate-snapping table already includes 64k/128k/
160k) but doesn't bundle a software fallback encoder for it. Confirmed
directly against this project's own Playwright Chromium build: MP3 encoding
was **not** supported there natively (AAC was) — not a hypothetical, the
actual result in the browser used to build and test this. Still worth
knowing even though the gap below closes it: `hooks/useExportFormatSupport.ts`
feature-detects every format via `mediabunny`'s `canEncodeAudio()` (optimistic
default of "supported" so the menu doesn't flash disabled while the check
runs) and the Export menu greys out + tooltips whatever comes back
unsupported, rather than letting a user pick a format that fails at encode
time — this stays in place as defense-in-depth even after the fix below,
since a WASM/Worker load can still fail in a sufficiently locked-down
environment (strict CSP, an ancient browser with no WebAssembly at all).

**MP3 is now guaranteed regardless of native browser support**, via
`@mediabunny/mp3-encoder` — an official first-party mediabunny extension
(same maintainers/repo, confirmed peer-compatible via `npm view` against this
project's installed `mediabunny` version before adding it), not a third-party
guess. It registers a `CustomAudioEncoder` wrapping a WASM build of LAME
3.100 running in a Web Worker. The mechanism that makes this a clean,
non-invasive fix: `canEncodeAudio()` checks registered custom encoders
*before* falling back to the native check (confirmed by reading
`encode.js`), so once the polyfill is registered, every existing call site
(`canEncodeFormat`, `encodeCompressed`) starts working unmodified — nothing
about the actual encode path changed, only whether a codec is available at
all. `utils/exportFormats.ts`'s `ensureMp3EncoderReady()` checks native
support first (free, no extra download when a browser already has one) and
only dynamically imports/registers the polyfill when it doesn't; module-level
cached promise so registration only ever runs once per page load.
`useExportFormatSupport` awaits it before running the per-format
`canEncodeFormat` checks. **Verified, not just measured against the
vendor's own claim**: after wiring this in, the MP3 menu item flipped from
disabled to enabled in this project's same Playwright Chromium build that
previously lacked native MP3 support — direct proof the polyfill closes the
exact gap it was built for. Performance measured against a real 5-minute
synthetic clip (not just the tiny clips the committed suite uses): full
export (render + encode + download) took ~10.2s end-to-end, output 4.58MB —
exactly the expected size at 128kbps (128,000 bits/s × 300s ÷ 8), confirming
correctness alongside timing. Extrapolated linearly, a real 3-hour podcast
lands around ~2 minutes — comfortably within the existing "Exporting…"
spinner's tolerance, no progress-bar need reopened by this. `e2e/export.spec.ts`'s
compressed-format test still picks whichever of MP3-128/AAC-128 is enabled at
runtime rather than hard-coding MP3 — now effectively always MP3 given the
polyfill, but kept format-agnostic on purpose: the disabled-fallback path is
still real defense-in-depth, not dead code, so the test shouldn't assume it
can never trigger.

**Filename convention**: `podcast-export-<timestamp>-<format>kbps.<ext>`,
e.g. `podcast-export-20260814-143000-mp3-128kbps.mp3`,
`...-aac-128kbps.m4a` — WAV keeps its pre-existing plain
`podcast-export-<timestamp>.wav` (no suffix), since it's the original default
rather than a new addition.

**`MenuButton` (`components/ui/MenuButton.tsx`) gained two small, generic
capabilities** for this, not Export-specific ones: a per-action
`disabled`/`title` pair (used for the unsupported-format tooltip above) and a
`variant` passthrough to the underlying `Button` (Export was a `variant=
"primary"` `Button` before gaining a dropdown; without this it would have
silently downgraded to `MenuButton`'s previous hardcoded `"secondary"`, losing
its visual weight as the one primary call-to-action in the top bar).

**Files**: `utils/exportFormats.ts` (format catalog, `canEncodeFormat`,
`ensureMp3EncoderReady`, `encodeCompressed`, `downloadBlob`),
`hooks/useExportFormatSupport.ts` (feature-detection hook, now also drives
the polyfill registration above), `hooks/useProjectExport.ts` (now
format-aware — `isExporting` covers both the render *and* the
compressed-encode step, via a separate local `isEncoding` state, so the
editor-blocking overlay stays up continuously instead of flickering off
between the two), `components/ui/MenuButton.tsx` (the two capabilities
above), `components/layout/TopBar.tsx` (Export is now built from
`EXPORT_FORMAT_ORDER` instead of a single button).

Committed coverage: `e2e/export.spec.ts` gained a test asserting all 5 menu
items are present, a dedicated test asserting the MP3 menu item is
specifically enabled (not just "some compressed format is," which the
format-agnostic test below already covered but which would keep passing
silently if the polyfill mechanism itself broke — see the self-review fix
below), and a format-agnostic compressed-export size/filename test;
`e2e/silenceRemoval.spec.ts`'s own WAV-download test updated for the new
"open dropdown, then click WAV" shape. Full suite (145 tests) passed against
a fresh prod build.

**Two fixes from a pre-commit self-review**, not found by any test — asked
to critically re-read the implementation before committing: `ensureMp3EncoderReady`
originally cached a *rejected* promise forever on failure (a transient
network blip loading the dynamic import's chunk, or the Worker failing to
spawn, would have permanently disabled MP3 for the rest of the page session
with no way to recover short of a reload) — fixed by clearing the cache in a
`.catch()` before rethrowing, so a later call (a user simply retrying) gets a
fresh attempt. And the MP3-specific regression test above didn't exist yet —
the original compressed-format test was deliberately format-agnostic (a
deliberate, correct design for a genuinely environment-dependent capability),
but that same property meant it would have silently kept passing, by falling
through to testing AAC instead, even if the polyfill registration path
broke entirely. Both fixed in the same pass; noted here rather than treated
as if they'd always been right, since the whole point of this file is not
hiding what actually happened.

Not built (disclosed): Opus/FLAC (deferred, see above — the format list is
easy to extend), a UI affordance explaining *why* a greyed-out format is
disabled beyond the native tooltip, remembering the user's last-picked format
across sessions.

## Text-to-Speech (Cartesia) (done)

The first AI feature: a "+ Clip" toolbar dropdown next to "Export" with two
actions, "Upload clip file" (the previous standalone button's exact behavior,
unchanged) and "Generate clip (AI)" (opens a modal — text + voice picker —
that calls Cartesia server-side and inserts the result exactly like an
uploaded clip). Full original design: `TTS_CARTESIA_PLAN.md` — kept corrected
against what actually shipped (not left to drift stale), including a
"Superseded from the original plan" note on the one approach that was tried
and abandoned mid-build (below).

**Files**: `src/app/api/tts/route.ts` (server, holds `CARTESIA_API_KEY`),
`src/utils/cartesiaVoices.ts` (curated voice list + `MAX_TTS_TEXT_LENGTH`,
shared by both client and server so neither can drift from the other),
`src/utils/clipInsertion.ts` (`buildClipMeta`, extracted out of
`useTimelineTracks.ts`'s upload loop so upload and TTS insert a clip the same
way), `src/hooks/useGenerateSpeech.ts` (client: fetch → decode → commit,
mirrors `addFilesToTrack`'s shape trimmed to one clip),
`src/components/ui/MenuButton.tsx` (the "+ Clip" dropdown), `src/components/
tts/GenerateSpeechModal.tsx` (the generate form). `TopBar.tsx` wires it all
together with the same `activeTrackIdRef`/`currentTime` values `handleUpload`
already reads, so upload and generate land in the same place.

**Real bugs and gotchas found building this** (each caught by actually
building/running it, not by planning alone):

1. **The planned `ClipActionsMenu` generalization doesn't survive this repo's
   `eslint-plugin-react-hooks` "refs" rule.** The plan called for an optional
   `renderTrigger` prop so the "+ Clip" button could reuse `ClipActionsMenu`'s
   proven dropdown shape. That rule flags a DOM ref crossing *any* function
   call made during render — including a render-prop that only forwards the
   ref to a JSX `ref=` attribute, never reads `.current` — and this repo
   holds a clean `eslint` run as a hard bar with zero existing suppressions
   anywhere. Tried, reverted; `ClipActionsMenu.tsx` is untouched.
   `src/components/ui/MenuButton.tsx` is a small dedicated component instead
   — same portaled/positioned/dismissible dropdown shape, duplicated rather
   than shared, since its trigger button is fully internal (no ref ever
   crosses a function-call boundary). Lives in `ui/` alongside `Button.tsx`,
   not `layout/` or `clip-menu/`, since nothing about it is TTS- or
   toolbar-specific — `label`, optional `icon`, `minWidth`, and
   `actions: { id, label, onSelect, icon? }[]`.
2. **A hardcoded voice id can look right and still be wrong, or right and
   still fail once.** The first `cartesiaVoices.ts` list was four ids
   recalled from training data, not verified against a live account.
   Verifying live (`GET https://api.cartesia.ai/voices` against this app's
   own key) found three of the four genuinely exist, but the fourth
   (originally labeled "Reflective Woman") didn't exist in the catalog at
   all — that one would 404 on *every* use, not occasionally. Separately, a
   confirmed-*valid* id ("Sophie - Teacher") 404'd once during manual testing
   and succeeded on an immediate identical retry — a real, transient
   Cartesia-side hiccup, not a bad id, and the direct motivation for the
   retry logic below. Current list ids and names were re-derived from that
   live response, not invented; re-verify the same way if this ever starts
   404ing consistently rather than occasionally.
3. **`isGenerating` React state alone doesn't close a double-submit race.**
   Two `generateSpeech` calls landing before React re-renders/disables the
   Generate button (two rapid clicks, in principle) would both read
   `isGenerating === false` and fire two requests. Fixed with a synchronous
   `isGeneratingRef`, checked and set at the very top of `generateSpeech` —
   same reasoning this app's own `playPendingRef` already relies on (a ref
   flips synchronously, ahead of any render, where state can't).
4. **`route.ts` retries once on a 429 or 5xx, never on 4xx** — added directly
   in response to finding 2 above. A 400/404 is a deterministic client-input
   problem (bad text, unknown/genuinely-missing voice); retrying it only
   delays the same inevitable failure. Each attempt gets its own fresh
   timeout rather than sharing one budget across both.
5. **`e2e/tts.spec.ts` mocking `**/api/tts` via `page.route` is real coverage
   of the client, zero coverage of `route.ts` itself.** `page.route`
   intercepts at the *browser* level — the request never reaches the route
   handler at all, so nothing was actually verifying this route's own logic
   (validation, the outgoing Cartesia request shape, the retry behavior
   above). `e2e/ttsRoute.spec.ts` closes this by importing `POST` directly
   and mocking `global.fetch` — a plain in-process Node test, no browser, no
   dependency on the shared built/served Next app. That last part matters,
   not just for speed: hitting the real webServer over HTTP instead would
   need the outgoing Cartesia URL swapped to a local mock via an env var set
   at that server's *startup*, but `playwright.config.ts`'s
   `reuseExistingServer: !process.env.CI` means a developer's own
   already-running `npm run start` (pointed at the real Cartesia API via
   their real `.env.local`) would silently get reused instead, risking a
   real call to Cartesia during a test run. Covers the `container: "wav"`
   pin, retry-then-succeed, exhausted-retries, the no-retry-on-404 case as a
   named regression test for finding 2, and validation-before-network-call.
6. **A dead server on the shared test port produces failures that look like
   a real regression but aren't one.** Mid-verification, `npx playwright
   test` reported 55 failures, every one a 30s timeout on basic UI (e.g.
   `getByRole("button", { name: "+ New Track" })` never appearing) — looked
   exactly like the whole app had broken. Cause: an old, already-dead Next
   server was still listening on port 3000 (confirmed via `curl` returning
   nothing at all), and `reuseExistingServer: !process.env.CI` made
   Playwright reuse it instead of starting fresh. Killing it and restarting
   dropped the failure count to the 4 that were real (finding 7). Worth
   remembering as a first check next time a full suite run "breaks" with
   uniform, unrelated-looking timeouts: confirm the shared dev server is
   actually alive (`curl http://127.0.0.1:3000/`) before suspecting the code.
7. **A locator went stale mid-session, from an unrelated later edit, and
   only the full suite caught it.** After the "+ Clip" button gained a plus
   icon, its label changed from `"+ Clip"` to `" Clip"` (the "+" moving from
   text into the icon) — its accessible name became `"Clip"`, but
   `e2e/tts.spec.ts` still queried `{ name: "+ Clip" }`. Code review and
   `tsc`/`eslint` can't catch this class of drift (a string literal, not a
   type); only actually running the suite did. Fixed and extracted into a
   documented `ADD_CLIP_BUTTON` locator constant so the reason is written
   down, not just the fix.

Committed coverage: `e2e/tts.spec.ts` (4 tests, mocks `**/api/tts` at the
browser level — the "+ Clip" dropdown and modal open correctly, a successful
generate inserts a clip at the playhead and closes the modal, an error shows
inline and inserts nothing, undo removes a generated clip in one step) and
`e2e/ttsRoute.spec.ts` (7 tests, see finding 5). Full suite (62 tests) passed
against a fresh prod build.

Not built (disclosed): fetching Cartesia's full voice library at runtime
(hardcoded list of 4 for v1, see finding 2); any auth/rate-limiting on
`/api/tts` (deliberately deferred — this app is intended to merge into a
larger project that already has authentication, not meant to stand alone
indefinitely); `AddClipsDropZone.tsx` (the drag-and-drop upload strip at the
bottom of the track list) stays upload-only by design, not offered as a
second "Generate clip (AI)" entry point.

## Silence removal (done)

Energy/RMS-based, fully client-side, triggered from a clip's own "..." menu
("Remove silence"). Splices the kept (non-silent) audio into one new
continuous clip that replaces the original in place — same `startSample`,
no ripple to the rest of the timeline, track's clip count unchanged. Full
original design: `SILENCE_REMOVAL_PLAN.md`, kept corrected against what
actually shipped (not left stale), including a detailed review pass and a
UX rework both folded in after the initial build — same discipline as
`PERSISTENCE_UNDO_ORIGINAL_PLAN.md`/`TTS_CARTESIA_PLAN.md`.

**Files**: `src/utils/silenceDetection.ts` (`detectKeepRanges` — the
windowed-RMS/percentile-threshold/hysteresis/padding algorithm — and
`spliceOutSilence`, which wraps it plus the actual buffer splice),
`src/utils/wavEncode.ts` (`encodeWavPcm16`, needed only to get bytes to hash
and a `Blob` to persist — no standalone `AudioBuffer`→WAV encoder is
exported anywhere in `@waveform-playlist/browser`), `src/hooks/
useRemoveSilence.ts` (decode-or-compute-then-commit, mirrors
`useGenerateSpeech.ts`'s shape), `src/components/ui/Toast.tsx` (the
success/warning/error outcome toast — see "UX: overlay + toast" below),
`src/components/ui/WarningBanner.tsx` (extracted out of `PodcastEditor.tsx`,
now shared by both it and `EditorShell.tsx`). Wired into `src/components/
clip-menu/ClipActionsOverlay.tsx`'s existing per-clip menu and `src/
components/timeline/EditorShell.tsx` (owns `useRemoveSilence()` — see why
below).

**Algorithm** (see `SILENCE_REMOVAL_PLAN.md` for the full spelled-out
version): one RMS value per non-overlapping 20ms window (not per-sample —
keeps the percentile sort cheap on long clips), max across channels: a
noise floor is estimated as a low percentile (default 10th) of that
per-window series, multiplied by a linear threshold factor (default 3, ≈
+9.5dB); contiguous below-threshold runs of at least 0.4s count as real
silence (hysteresis, avoids chattering at every quiet phoneme); 0.1s of
padding is pulled back into the kept side of every cut; kept slivers under
0.1s after padding are folded into the surrounding silence. Reuses
`@waveform-playlist/core`'s `concatenateAudioData`/`createAudioBuffer` for
the actual splice rather than hand-rolling it.

**Real bugs found building and then actually using this** — an unusually
high count for one feature in this repo, because this is the first feature
here verified at every layer: a Node-side unit pass against the pure
algorithm *before* ever touching a browser (deliberately, per the
implementation-order plan — cheapest place to catch algorithm bugs), then
full browser/e2e verification, then a manual pass by the user against a
real, non-synthetic recording:

1. **Padding manufactured phantom "kept" slivers at the absolute start/end
   of a buffer.** The padding step (pull the kept side of every cut inward
   by `paddingSeconds`) was originally applied unconditionally to *every*
   silence run's boundaries, including ones touching the buffer's own start
   or end — where there's no real flanking content to give a lead-in/lead-
   out cushion to. Most visible on a fully-silent clip: two padding-sized
   slivers at the very ends survived the tiny-sliver merge and the clip
   never read as "no speech found" at all. Caught by the Node-side unit
   pass, not reasoning alone. Fixed: a silence run's boundary gets no
   padding on whichever side touches the buffer's own edge.
2. **A purely relative threshold can't tell "uniformly loud" (a constant-
   level tone) apart from "uniformly near-silent"** — both look like "no
   contrast" to a percentile-only check, but need opposite outcomes (leave
   alone vs. this is all silence). Fixed with `ABSOLUTE_QUIET_FLOOR`
   (~-50dBFS), used only to break that specific tie; the main threshold
   stays fully relative/self-calibrating otherwise.
3. **`rms <= threshold`, not `rms < threshold`.** True digital-zero silence
   combined with a noise floor that also computes to exactly 0 never
   matched a strict `<` against its own threshold (0 < 0 is false) — nothing
   was ever classified as silence. Only surfaced once a real synthetic WAV
   with literal-zero silence segments was run through the actual app in a
   browser; the Node-side unit tests happened to use dithered near-zero
   noise for "silence" (more realistic anyway) and never hit this. Real
   recorded silence is never exactly 0, but digitally-generated/edited
   silence can be — worth remembering if this ever regresses.
4. **The biggest one: `processingClipId` threaded as a prop through
   `TimelineStage.tsx` caused a spurious full engine rebuild on every
   silence-removal call, independent of whether anything actually
   changed.** `TimelineStage.tsx`'s `hydratedTracks = lastEngineOutput
   ?.dehydrated === tracks ? lastEngineOutput.raw : hydrate(tracks)` only
   reuses its cached array when that passthrough condition holds — true
   only right after a `commitEngineOutput` call. After *any* plain
   `commit()` (upload, duplicate, undo, redo — none of which touch
   `lastEngineOutput`), that condition goes false and stays false until some
   future trim/split re-establishes it — meaning **any** re-render of
   `TimelineStage` in that window, for *any* reason, recomputes `hydrate()`
   fresh (a brand-new top-level array, even with every individual track
   object cache-hit-identical) and triggers a full rebuild. Nothing before
   this feature ever exercised that path: existing state changes threaded
   through `PodcastEditor.tsx` either landed in the same batched render as
   a real `commit()` (masking the issue) or never fired in that window at
   all. `processingClipId`, toggling on its own around an async pipeline
   that often commits nothing at all ("no silence detected"), was the first.
   Found by instrumenting `commit()`/`commitEngineOutput()` directly and
   observing an extra `waveform-playlist:ready` dispatch with neither ever
   firing. Fixed by moving `useRemoveSilence()` (and its overlay/toast)
   entirely below `TimelineStage`, into `EditorShell.tsx` — its state
   changes now only re-render that subtree, never `TimelineStage` itself.
   Note this is a **latent bug in the app generally**, not something this
   feature introduced: any future piece of state that changes independently
   of a `commit()`, if threaded above `TimelineStage`, will hit the same
   wall. Not fixed at the root (would mean reworking `TimelineStage`'s own
   passthrough-cache/`hydrate()` architecture) — worked around here.
5. **A concurrent-modification race the original "clip still exists" guard
   didn't fully cover.** `removeSilence` captures a clip's boundaries once
   and uses them for the whole async pipeline; trimming/dragging that same
   clip is a separate interaction path (`ClipDragLayer.tsx`) never gated by
   the single-flight guard, so the clip could still exist but have
   different boundaries by the time the result is ready to commit. Fixed:
   the pre-commit re-check compares `offsetSamples`/`durationSamples`/
   `startSample` against the live clip, not just its existence, and
   discards with a message if either changed.
6. **Every e2e fixture was mono, so the `channelCount`-defaults-to-1
   splice bug (below) had zero regression coverage** — mono is also that
   bug's own buggy output, so a regression wouldn't have changed any
   existing test's result. Added a stereo fixture
   (`makeStereoSegmentedWavFile`, `e2e/fixtures.ts`) and a dedicated test;
   confirmed it actually catches the regression via A/B (reverted the fix,
   watched the test fail with `numChannels: 1`, restored it).
7. **`createAudioBuffer`'s `channelCount` parameter defaults to 1** —
   confirmed by reading `core/dist/index.js` directly. Omitting it on a
   stereo clip doesn't throw; it silently drops every channel past the
   first. `spliceOutSilence` always passes it explicitly now.
8. **The loading overlay (see below) visibly waited before appearing on a
   real recording** — reported directly by the user, not caught by any
   automated test (small synthetic clips never made this visible).
   `setProcessingClipId` only *schedules* a re-render; React can't actually
   paint it until the calling code's own synchronous execution yields back
   to the event loop, and the RMS scan + splice immediately after it is one
   large synchronous, CPU-bound block that was itself delaying that yield —
   so the menu stayed open and the overlay stayed hidden for the entire
   scan, only updating once the (already-finished) work let the function
   proceed. Fixed with a single `await new Promise(resolve =>
   setTimeout(resolve, 0))` inserted right before the scan starts. Measured
   against a real 10-minute synthetic clip: menu-close and overlay-visible
   both now land within ~5ms of the click (previously stuck for the ~1s the
   whole operation took); the overlay then correctly stays up for that full
   ~1s. Not fully solved for a *much* longer clip's spinner staying
   perfectly smooth throughout the scan itself (still one blocking
   synchronous chunk after the yield) — chunking the scan loop or moving it
   to a Web Worker would close that gap; not done here, since the reported
   problem was specifically the pre-overlay delay, not an unresponsive
   spinner during it.

**UX: overlay + toast.** Originally shipped with a narrow, per-clip-menu-
item busy indicator (disable/relabel just that one action). Revised after
direct feedback to match Export's own established pattern instead: a full-
editor-blocking overlay (`data-testid="silence-removal-overlay"`, identical
markup to `export-overlay` — translucent scrim + spinner + message) while
processing, with the top bar and transport bar disabled the same way
`isExporting` already disables them. On completion, a new `Toast` component
(`ui/Toast.tsx`) — fixed, bottom-center, pill-shaped, auto-dismisses after
5s, still manually dismissible — reports the outcome: green for a real trim
("Silence removed."), amber for a no-op ("No silence detected in this
clip." / "No audio detected above the silence threshold."), red for a
failure (an exception, or the clip vanishing/changing underneath the
operation — see bug 5 above). Same shape/weight across all three, only the
color changes, so they read as one family. Deliberately *not* used for a
failed asset-persistence save (silence removed successfully, but the result
couldn't be saved for offline use) — that has a lasting consequence (won't
survive a reload) a 5-second toast would undersell, so it still uses the
persistent, manually-dismissed `WarningBanner` pattern
`useTimelineTracks.ts`'s own `saveWarning` already established.

**Known, disclosed gaps**:

- **The noise-floor percentile needs the clip's *aggregate* silence to be
  roughly at least `noiseFloorPercentile` (10%) of its total duration to
  calibrate correctly** — a real, inherent tradeoff of self-calibrating
  (vs. one fixed) thresholding, not a bug. Confirmed directly against a
  short manual test clip (a ~11s clip needed a gap of ~1.1s, not the nominal
  0.4s minimum, before it was detected at all) — bites hardest on short
  clips with only one deliberate gap; a real podcast's pauses usually sum to
  well over 10% of total runtime across the whole episode, so this matters
  less at this app's actual target scale. Reviewed and left as the shipped
  default (`noiseFloorPercentile: 0.1`) at the user's explicit call, not
  silently accepted without consideration.
- **Two timing races found while testing are disclosed as unprovable, not
  silently dropped**: the per-clip menu item's disabled state during
  processing, and directly observing the overlay mid-flight in an automated
  test. Both reproducibly failed even under 1000x CPU throttling and a
  ~100s test clip — removeSilence's dominant cost (`crypto.subtle.digest` +
  the IndexedDB write) doesn't run on the throttled main JS thread, unlike
  the CPU-bound work CPU throttling actually slows. Same class of "not
  solved by an automated test" race as the play()/rebuild race documented
  above. Both are correct by inspection (`processingClipId` set
  synchronously, cleared in `finally`, both gated identically to
  `isExporting`); the committed suite instead asserts the provable half —
  the editor is never left stuck disabled afterward.
- **The RMS scan + splice remains one synchronous, unchunked block** once
  it starts (see bug 8 above) — fine for this app's realistic clip lengths
  (measured ~1s for a 10-minute clip), but a multi-hour clip could still
  visibly freeze the spinner for a longer stretch. Chunking the loop with
  periodic yields, or moving it to a Web Worker, would close this; neither
  attempted here (`SILENCE_REMOVAL_PLAN.md`'s own "Not built" list already
  flagged this as a deferred v2 risk).

Committed coverage (`e2e/silenceRemoval.spec.ts`, 7 tests; `e2e/fixtures.ts`
gained `makeSegmentedWavFile`/`makeStereoSegmentedWavFile`; `readWav` moved
from `export.spec.ts` into `e2e/helpers.ts` and generalized with a
per-channel argument so both files share one implementation): kept-duration
matches a hand-computed reference clip via exactly one engine rebuild; undo
restores the original clip and audio in one step; a silence-free clip is a
genuine no-op (no rebuild, no new history entry); the editor is fully
re-enabled after processing settles; the success toast auto-dismisses on
its own after 5s; the spliced clip survives a reload and still plays; a
stereo clip's channels stay distinct after removal (the regression test for
bug 7, confirmed via A/B to actually catch it). Full suite (69 tests) passed
repeatedly against a fresh prod build, plus a manual pass against a real
10-minute synthetic recording measuring the actual UI-response timing (see
bug 8) — not just the small clips the committed suite uses.

## Transcription pipeline + Audio search (done)

Word-level transcription (Whisper via OpenRouter) for every uploaded/
generated clip, feeding a "Search in the podcast" popover. Full design:
`TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md`, kept corrected against what
actually shipped, same discipline as `SILENCE_REMOVAL_PLAN.md`/
`TTS_CARTESIA_PLAN.md`. Filler-word removal — the other feature this
pipeline was built for — is not started; see that plan doc's Phase 6 for the
intended design.

**The one finding that shapes the whole design**: `ClipMeta`/`AudioClip`
already carries everything needed to make a transcript survive move/trim/
split for free — `assetId` (which source asset), `offsetSamples` (where a
clip starts inside that asset), `durationSamples` (how much of the asset it
uses), `startSample` (where it sits on the timeline). Storing one transcript
per `assetId`, in seconds relative to that asset's own start (never per-clip,
never timeline-relative), means a move (only changes `startSample`) or a trim
(only changes `offsetSamples`/`durationSamples`) needs zero new invalidation
logic. Split also preserves it (confirmed via `assetRegistry.ts`'s
`getAssetId` — the library passes the same buffer by reference to both
halves). Only a **splice** (silence removal, and filler-word removal once
built) breaks this, since it mints a new content-hash `assetId` — see the
remap step below.

**Files**: `src/utils/audioCompression.ts` (chunk-then-Opus-encode, via
`mediabunny`), `src/utils/concurrency.ts` (`settleWithConcurrencyLimit` —
generic, Node-unit tested `Promise.allSettled`-with-a-cap helper; see below),
`src/utils/transcription.ts` (`runTranscriptionPipeline` —
plain function, not a hook, called from both the upload and TTS paths),
`src/app/api/transcribe/route.ts` (holds `OPENROUTER_API_KEY`, mirrors
`api/tts/route.ts`'s retry-on-429/5xx-never-4xx shape exactly), `src/utils/
transcriptWindow.ts` (`wordsInWindow` — the one "which words are audible in
this clip" filter, shared by search and the remap below so the rule can't
drift), `src/utils/transcriptRemap.ts` (`remapWordsThroughKeptRanges` — see
below), `src/utils/transcriptSearch.ts` (pure phrase-search logic) +
`src/hooks/useTranscriptIndex.ts` (the reactive wrapper), `src/components/
search/SearchButton.tsx` (the whole search UI — self-contained trigger +
popover, modeled on `ui/MenuButton.tsx`'s positioning/dismiss mechanics).
`src/store/transcriptStore.ts` is a **new, separate** Zustand store (`assetId
-> AssetTranscript`) — deliberately never wired into `projectStore.ts` or
read above/inside `TimelineStage.tsx`, to avoid a second instance of the
`processingClipId` bug documented in "Silence removal" below (any state that
changes independently of a real `commit()`, if visible above `TimelineStage`,
defeats its passthrough-cache and forces spurious full engine rebuilds — this
store's status changes constantly and asynchronously, exactly that class of
state). `src/utils/persistence.ts` gained two IndexedDB stores
(`compressedAssets`, `transcripts`; `DB_VERSION` bumped to 2, `upgrade()`
guarded on `oldVersion` so an existing v1 database isn't recreated).
`useProjectHydration.ts` now also batch-loads transcripts on mount and
re-kicks any left `"pending"`/`"transcribing"` from a tab closed mid-flight
(cheap — reuses the already-persisted compressed chunks, no re-decode/
re-compress).

**Compression: chunk-first, then Opus-encode each chunk** — not one
whole-asset compressed file. OpenRouter's transcription endpoint has both a
25MB size cap AND a ~60s upstream processing timeout independent of size (a
tiny-but-long Opus file can still time out); chunking by duration (~10
min/chunk) solves both at once, and a chunk is reused as-is for its own
transcription request body with no second encode pass. `mediabunny` (not
`opus-recorder`, tried first and rejected — confirmed via its own README
it's built exclusively around live `MediaStream` capture, with no way to
feed it an already-decoded buffer without literally replaying it in real
time) does the actual encode: `AudioBufferSource` takes a real `AudioBuffer`
directly, `OggOutputFormat` + `BufferTarget` produce a self-contained file in
memory. **Requires a secure context** (`AudioEncoder` is `undefined`
otherwise) — a non-issue for this app (always `localhost` or real HTTPS), but
`playwright-core`'s default headless launch (`chromium_headless_shell`) has
no `AudioEncoder` at all, unrelated to secure-context — any Playwright
verification of this feature (manual scratchpad script or a future committed
e2e spec) must launch the full Chromium binary (`chrome-win64/chrome.exe`
under the cached revision folder), not rely on the default headless config,
or it fails for a reason that has nothing to do with the app. Real measured
number: a ~5s real-speech clip compressed from 418KB (WAV) to 13KB
(mono/16kHz Opus, 24kbps) — ~97% smaller.

**OpenRouter request/response, confirmed live** (not trusted from docs alone
— same discipline as Cartesia's voice-list finding below): `POST https://
openrouter.ai/api/v1/audio/transcriptions`, `model: "openai/whisper-large-v3"`,
`response_format: "verbose_json"`, `timestamp_granularities: ["word"]`,
multipart `file`. Response: `{ text, usage: {seconds, cost}, language,
duration, words: [{ word, start, end }] }` — the field is `word`, not `text`
as an earlier docs pass assumed. Word-level timestamps confirmed accurate
against a known phrase, both on a raw WAV and on the actual compressed Opus
file this pipeline produces.

**Chunk requests are concurrency-capped at 3, and the merge across chunks is
verified live, not just reasoned about** — both added in a post-Phase-5
self-review. A long asset (18 chunks for a 3-hour podcast at the default
10-min chunk size) firing every chunk at OpenRouter simultaneously is a real
way to trigger rate limiting; `transcription.ts` now runs chunk requests
through `concurrency.ts`'s cap instead of a bare `Promise.allSettled`. The
original Phase 0-3 pass never actually exercised >1 chunk (every test clip
produced exactly one) — closed by temporarily lowering
`CHUNK_DURATION_SECONDS` to 8s and uploading a real ~12.6s clip with 3
chapter-marker checkpoints spanning the boundary: exactly 2 requests fired,
36 words merged in correct order, and the marker spoken *after* the boundary
landed at 9.5s, not reset near 0 — confirming the chunk-offset math. Constant
reverted afterward; a full rebuild confirmed unchanged default behavior.

**Re-transcription for spliced assets (silence removal today; filler-word
removal will hit the same path once built): remap, not re-transcribe.**
`silenceDetection.ts`'s `spliceOutSilence` now also returns `keepRanges`;
`useRemoveSilence.ts` remaps the source clip's transcript through them
locally (`transcriptRemap.ts`) with zero network call whenever the source had
a finished transcript to remap from — keeps silence removal's existing
"fully client-side, no server round trip" property intact. Falls back to a
real `runTranscriptionPipeline` call only if the source transcript wasn't
ready. **Verified live**: a synthetic clip built from two real
Cartesia-synthesized phrases separated by a genuine 3s silence gap — all 16
transcribed words survived except the ones actually inside the removed gap
(correctly dropped, including one that straddled a cut boundary), the new
asset's transcript appeared **~7ms** after the splice committed (vs.
500ms-2s+ for every observed real OpenRouter call — unambiguous proof the
local remap ran, not the network fallback), and the first word after the gap
shifted by ~2.78s — matching the ~3s gap minus the padding silence removal
keeps on each cut's edges.

**Search UX, per direct user spec** (not the original plan sketch's
TopBar-owned-state assumption): `SearchButton.tsx` owns its own
`query`/`submittedQuery`/results state directly — it never unmounts (lives in
`TopBar.tsx`, which survives every engine rebuild), so closing the popover
only toggles visibility, satisfying "search and results persist until
cleared" with no extra store. **Search runs on Enter, not on every
keystroke** (changed after initial live-search felt noisy) — editing the
query afterward without pressing Enter again leaves the last results
showing, doesn't blank them. Transcription status is invisible to the
searching user by design: if any clip's transcript is still catching up when
Enter is pressed, the popover just shows the same generic "Searching…" state
`useTranscriptIndex.ts`'s `isTranscribing` flag drives — never a
transcription-specific message. Selecting a result calls
`usePlaylistControls().seekTo()` with the match start minus a fixed 0.5s
lead-in (clamped to 0) and reuses `EditorShell.tsx`'s existing
`setSelectedClip`, threaded down through `TopBar.tsx` exactly like every
other clip-mutation callback already is. Result-card timestamps use the
**standalone** `formatTime` from `@waveform-playlist/ui-components`
(`"hh:mm:ss"`, no decimals) — deliberately not `usePlaylistControls()
.formatTime` (which drives current-time/total-duration elsewhere at their
own, unrelated precision and would have been an app-wide format change).
Matched text renders in a real `<mark>`, styled with the same
`--accent-purple-100`/`-700` pair `ClipActionsOverlay.tsx`'s own clip-name
labels already use, not a new color. `useTranscriptIndex.ts` is **per-clip
memoized** via a module-level `clipCache` (added post-Phase-5 — the original
version rescanned every clip's words on any single unrelated transcript
update, since `transcriptStore`'s record is a new object reference on each
one; same fix shape as `dehydrate()`'s own per-track cache below. Module-
level, not `useRef` — this repo's `eslint-plugin-react-hooks` "refs" rule
rejects reading `ref.current` during render even inside `useMemo`, same rule
the Phase 1 notes above already document hitting once). **Verified live**: uploaded real speech
("Welcome to the Elephant Sanctuary Podcast…"), searched "elephant" — 2
correctly-matched results, selecting one flipped the toolbar's Duplicate
button from disabled to enabled (selection confirmed) and moved
`current-time` to exactly `match_start - 0.5s`; typing without pressing Enter
produced zero results (confirming the old debounce-driven live search is
really gone); closing and reopening the popover preserved the same query and
results.

**Not built / disclosed gaps**: no committed Playwright suite for any of
this yet (every phase verified live via ad-hoc scratchpad Playwright
scripts against real production builds and, where relevant, real Whisper/
Cartesia calls — see "Verification approach" below); a `"failed"` transcript
(every chunk failed) has no retry affordance beyond the reload-time re-kick;
the filler-word dictionary/UI itself doesn't exist yet (see the "Planned
features" bullet above and the plan doc's Phase 6); a stale `next dev`/`next
start` process left running on port 3000 from an earlier session silently
absorbed test traffic more than once while verifying this feature — same
"confirm the shared dev server is actually alive before suspecting the code"
gotcha this file's own "Verification approach" section already documents,
worth remembering specifically because it recurred here.

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
- **`CARTESIA_API_KEY` must be set (server-only, never `NEXT_PUBLIC_*`) for
  "Generate clip (AI)" to work.** Read by `src/app/api/tts/route.ts` from
  `process.env` — unset, the route returns a clean 500 instead of a
  mysterious failure, so the symptom is obvious in dev. Get a key from
  Cartesia's dashboard; put it in `.env.local` (already covered by the
  repo's blanket `.env*` gitignore rule, so no `.gitignore` exception or
  committed `.env.example` was added — see `TTS_CARTESIA_PLAN.md`'s Step 5).
  Not required for anything else in the app; every other feature works with
  it unset. Restart the dev/prod server after adding it — this route is
  server-rendered on demand (confirmed in `npm run build`'s route summary:
  `ƒ /api/tts`, not prerendered), so it reads the env var at request time,
  but the process still needs to have loaded it at startup.
- **`@waveform-playlist/core` is a direct dependency**, added for silence
  removal's splice step (`concatenateAudioData`/`createAudioBuffer` — see
  "Silence removal" below). It was already resolved transitively via
  `browser`/`engine`/`ui-components` before this, so nothing new actually
  installs; only `package.json` gained a manifest entry.
- **`OPENROUTER_API_KEY` must be set (server-only, never `NEXT_PUBLIC_*`) for
  transcription (and therefore search) to work.** Read by `src/app/api/
  transcribe/route.ts` from `process.env` — unset, the route returns a clean
  500, same pattern `CARTESIA_API_KEY` above already established. Not
  required for anything else — every other feature (including playback,
  editing, export) works with it unset; a clip just never gets a transcript,
  so it's silently excluded from search. Restart the server after setting it.
- **`mediabunny` is a direct dependency**, added for the transcription
  pipeline's compression step (Opus-encoding an already-decoded `AudioBuffer`
  — see "Transcription pipeline + Audio search" above for why it was chosen
  over `opus-recorder`). A genuinely new install, not a transitive one
  already resolved like `@waveform-playlist/core` was.
- **`@mediabunny/mp3-encoder` is a direct dependency**, added so MP3 export
  works regardless of native browser support — see "Compressed export
  (MP3/AAC)" above. Official first-party mediabunny extension package, not a
  third-party pick; peer-compatible with this project's installed
  `mediabunny` version (`^1.0.0` required, `1.53.0` installed — confirmed via
  `npm view` before adding it, not assumed from a search result). Lazily
  imported (`utils/exportFormats.ts`'s `ensureMp3EncoderReady`), so a browser
  with native MP3 support never pays its ~130KB gzipped cost at all.

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

### Uploading onto an occupied playhead position no longer overlaps

`addFilesToTrack` inserts a batch starting at the playhead, treating the
whole batch as one span (summed duration of every file in it, so the batch
stays contiguous with itself). `utils/clipGeometry.ts`'s
`resolveNonOverlappingStart` walks the target track's existing clips in
sorted order and pushes the batch's start forward past each one it
overlaps — checked against the *already-pushed* candidate at each step, not
just the original proposed position, so a push past a close clip can't land
back on top of a farther one. Never pushes backward, never splits the batch
across a gap. Reused as-is everywhere else a new clip position gets
computed, rather than duplicating the math: `ClipDragLayer.tsx`'s drag/drop
block-or-clamp path (see "Clip dragging" below) and
`useClipActions.ts`'s `duplicateClip` (placed right after the source clip,
pushed further if something was already sitting there).

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
exported, but isn't imported anywhere in this file — it only examines the
one immediate prev/next neighbor around a clip's proposed position, which
isn't enough when a target track has 2+ clips and a drop needs to skip past
more than one of them. Collision blocking instead uses
`utils/clipGeometry.ts`'s `resolveNonOverlappingStart` (the same function
`useTimelineTracks.ts`'s upload path uses, see "Uploading onto an occupied
playhead position" above), which walks every existing clip on the target
track in order rather than just whichever one ends up adjacent in a merged
sort. See "Clip swap confirmation" below for the one same-track case that
isn't a block/clamp at all (the pointer landing directly on an immediate
neighbor offers a swap instead). The rest of this section (cross-track
target detection, `TRACK_ROW_HEIGHT_PX`) is unaffected by any of this.

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

## Clip swap confirmation (same-track reorder-past-a-neighbor)

Clip overlap is blocked by default everywhere in this app (drag or upload) —
neither the original drag-start-anchored `engine.moveClip()` gap-sliding nor
a later free-overlap-everywhere revision survived; both were superseded by
what's described below. In `ClipDragLayer.tsx`:

- Every drop is blocked from overlapping a neighbor by default
  (`resolveNonOverlappingStart` — see "Clip dragging" above).
- Exception: a **same-track** drop where the pointer, at release, is
  literally resting on top of a single immediate neighbor
  (`findSameTrackNeighborAtPointer`, hit-tested via `utils/clipGeometry.ts`'s
  `resolveClipAt` against the raw drop coordinates — not whether the dragged
  clip's own computed span happens to reach into a neighbor) defers the
  commit and shows `ClipSwapConfirmPopover` instead of blocking. Confirming
  swaps the two clips' positions (`computeSwapPositions` — contiguous, not a
  naive `startSample` exchange, since durations can differ); declining (or
  dismissing via Escape/outside-click, or clicking anywhere else) leaves the
  clip exactly where it started, since nothing commits until confirmed.
- Landing on a non-adjacent clip, or on genuinely empty space (even if the
  dragged clip's own length would reach into a neighbor once placed there),
  isn't a swap — both fall back to the plain block/clamp path.
- Cross-track drops always just block/clamp, never offer a swap — there's no
  "current neighbor" to swap with on a track the clip wasn't already on.
- `confirmPendingSwap` re-looks-up both clips by id and re-checks they're
  still each other's immediate neighbor before applying the swap (not "still
  overlapping" — committed states never overlap), reading `pendingSwap` from
  the closure rather than an updater-callback argument so the commit/
  `flushSync` side effects run as ordinary function-body code, not from
  inside a setState updater (same rule `useFadeDragHandlers.ts` already
  documents). Guards against another commit (a second drag, duplicate/
  delete, undo/redo) landing while the popover was open; an engine rebuild
  while it's open unmounts `ClipDragLayer` entirely, discarding the pending
  state for free.
- The swap commit reuses the existing `commitEngineOutput` path unchanged —
  it's undo-able in one step, same as every other hand-applied move, with
  zero changes needed in `store/projectStore.ts`.

## Known limitations (disclosed, not silently accepted)

- **Same-track swap only reorders a single immediate neighbor pair** — by
  design (see "Clip swap confirmation" above), not a limitation to fix.
  Landing on a non-adjacent clip, or in empty space, falls back to
  block/clamp with no swap offer; sequential drags cover multi-position
  moves.
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
- **Every committed fade edit triggers a full engine rebuild**, same as a
  clip move — see "Fade in/out" above for why (no engine-native fade
  primitive exists in `@waveform-playlist/engine`). Repeatedly nudging a
  fade handle to fine-tune it costs one rebuild per release, same class of
  cost a repeatedly-nudged clip move already has; not specific to fades and
  not fixable from this app without an upstream engine change. Fade curve
  shape is also fixed to `"linear"` for v1 — no per-clip picker yet, though
  the field already round-trips through undo/redo and persistence, so
  adding one later doesn't touch either.
- ~~Mute/solo/volume/pan clicks never update this app's own state~~ —
  **fixed**, see "Post-Phase-3 fix: mute/solo/volume/pan never persisted,
  and scrambled after add/remove-track (FIXED)" above. Still not itemized
  in the undo stack (disclosed there, not attempted).
- **Export at this app's actual target scale (2-3 hour podcasts)** holds the
  decoded source buffers, the rendered offline `AudioBuffer`, and the final
  WAV `Blob` in memory simultaneously — a rough 3-hour stereo 16-bit render
  is on the order of ~2GB for the Blob alone. Same unstress-tested-at-scale
  risk the playback memory limitation above already flags, just compounded.
