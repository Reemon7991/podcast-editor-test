# Persistence + Undo/Redo layer

## Context

The editor currently holds all state (`tracks: ClipTrack[]`) in a single `useState`
inside `useTimelineTracks.ts`, with no history and no survival across a reload —
both explicitly called out as the two biggest gaps in `CLAUDE.md`'s roadmap (and
the current branch, `persistence/undo-layer`, is already named for this work).
`AudioClip` (the library's clip type) embeds the decoded `AudioBuffer` directly on
each clip object, so naively wiring undo/redo or persistence on top of the current
shape would duplicate/serialize raw PCM data — the thing CLAUDE.md's own "Known
limitations" section already flags as the next real scaling risk.

This plan separates clip **metadata** (small, JSON-safe, history/persistence-able)
from clip **audio data** (large, session-scoped, never cloned or serialized
directly), and builds a committed test harness, undo/redo, and IndexedDB
persistence on top of that split, in that order. All of this was designed and
refined in conversation before this plan was written, including a verification
pass against the actual library source (`@waveform-playlist/browser`/
`@waveform-playlist/engine` dist code) to confirm assumptions about `splitClip`'s
field whitelist and the provider's rebuild-avoidance logic, and a second review
pass (re-confirmed independently against the same dist source) that reworked the
asset-identity strategy and the undo/redo store's API to close two real gaps found
in the first draft — see "Confirmed library behavior" and the callouts inline
below, none of this is guesswork.

This is a paid, production engagement with more features planned on top of this
layer — undo/redo and persistence are exactly the kind of feature that's expensive
to keep re-verifying by hand every time a later feature touches the same code
paths, so Phase 0 below commits a real test harness instead of continuing this
project's prior ad-hoc-Playwright-script-per-session pattern.

## Core mechanism: metadata/binary split

```ts
// audio-engine/persistence/types.ts
type ClipMeta = Omit<AudioClip, "audioBuffer"> & { assetId: string };
type TrackMeta = Omit<ClipTrack, "clips"> & { clips: ClipMeta[] };
```

(`AudioClip` also has an optional `waveformData` field for a peaks-first rendering
flow this app doesn't use — nothing here ever sets it, so there's nothing to strip;
`audioBuffer` is the only field actually in play.)

`TrackMeta[]` is the only shape that ever enters undo/redo history or IndexedDB.
The real `ClipTrack[]` (audioBuffer inline — the "hydrated" form) is a derived,
ephemeral view that exists only as the `tracks` prop fed to `WaveformPlaylistProvider`.

**Asset registry** (`audio-engine/persistence/assetRegistry.ts`) — module-level, never part of
React/Zustand state:
```ts
const buffersById = new Map<string, AudioBuffer>();
const idsByBuffer = new WeakMap<AudioBuffer, string>();
function registerAsset(buffer: AudioBuffer, assetId: string): void { ... }
function getAssetBuffer(assetId: string): AudioBuffer | undefined { ... }
```

**`assetId` is a content hash (SHA-256 of the uploaded `File`'s bytes, hex-encoded
via `crypto.subtle.digest`), not a random UUID** — minted once, at upload time, in
`addFilesToTrack` (Phase 1), and threaded everywhere else as a known value. This is
a deliberate change from the first draft of this plan (which minted a UUID per
upload and left content-based dedup as a "maybe later" for Phase 3): two
independent uploads of the same file (a reused intro/outro jingle across episodes
is a very plausible workflow for a podcast editor) now hash to the same `assetId`
automatically, which means dedup falls out for free —
- In memory: `registerAsset(buffer, assetId)` is always called with a known id now
  (never mints one), so `buffersById.set(assetId, buffer)` on a second upload of
  identical bytes just overwrites the entry with an equivalent buffer — harmless.
- On disk (Phase 3): `saveAsset(assetId, blob)` is an IndexedDB `put` keyed by
  content hash — writing the same content twice overwrites the same record instead
  of creating a duplicate. No separate reverse-lookup/dedup step needed anywhere.

This also still correctly covers clip-splitting's asset reuse, for a different
reason than content-hashing: **confirmed by reading
`@waveform-playlist/engine/dist/index.js`'s `splitClip()`**: it builds both
resulting clips via an explicit field whitelist passed to `createClip()` (not a
spread of the original clip — any custom field we add would be silently dropped),
but it does pass `audioBuffer: clip.audioBuffer` through by the same object
reference to both halves. So when `dehydrate()` processes a freshly-split clip, it
calls `registerAsset`'s lookup on that same buffer reference and finds the
already-registered `assetId` via `idsByBuffer` — no re-hash needed, since nothing
was re-decoded.

**Implementation gotcha to verify on first pass**: hash the file's bytes *before*
calling `decodeAudioData`, not after (or from a defensive `ArrayBuffer.slice()`
copy) — some engines' Web Audio implementations have historically neutered
(detached) the buffer passed to `decodeAudioData`. Hashing first side-steps the
question entirely rather than relying on current spec behavior holding.

**Boundary functions** (`audio-engine/persistence/clipHydration.ts`):
- `hydrate(tracks: TrackMeta[]): ClipTrack[]` — joins metadata + registry.
- `dehydrate(tracks: ClipTrack[]): TrackMeta[]` — strips buffers, resolves `assetId`.

These two functions are the *only* reason `ClipDragLayer.tsx`, `ClipActionsOverlay.tsx`,
`useScissorsSplit.ts`, and `clipGeometry.ts` need **zero changes** — they all read
`tracks` via the library's own `usePlaylistData()` context, which is populated from
whatever `hydrate()` produced. Only `useTimelineTracks.ts`, `useClipActions.ts`,
`ClipActionsOverlay.tsx` (guard only, see Phase 2), and the `TimelineStage.tsx`/
`PodcastEditor.tsx` wiring change.

### Confirmed library behavior — rebuild-avoidance regression, and the fix

Read `@waveform-playlist/browser/dist/index.js` (~line 2057-2274) directly. The
provider skips a full engine dispose+rebuild only when the `tracks` prop is the
exact object reference it last produced internally:
```js
const isEngineTracks = tracks === engineTracksRef.current;
const isIncrementalAdd = engineRef.current !== null && tracks.length > prevTracks.length
  && prevTracks.every(pt => tracks.find(t => t.id === pt.id) === pt); // per-track reference check
skipEngineDisposeRef.current = isEngineTracks || isDraggingRef.current || isIncrementalAdd;
```
Today, `onTracksChange` flows straight to `setTracks`, so trims/splits (engine-driven)
keep this identity and skip a rebuild. Once `hydrate()` sits between our state and the
`tracks` prop, it necessarily allocates a new object graph every time — `isEngineTracks`
would become permanently false, turning every trim/split into a full rebuild (the same
slow-for-large-sessions path already documented for clip moves).

**Decision (confirmed with user): build the mitigation now, not deferred.** Two
complementary caches:

1. **Whole-array passthrough cache**, in `TimelineStage.tsx`: when `onTracksChange(raw)`
   fires, stash `{ dehydrated: dehydrate(raw), raw }` in **component state** (a
   `useState`, not a ref — this project's ESLint config, on this bleeding-edge
   React/Next setup, enables `eslint-plugin-react-hooks`' `refs` rule, which rejects
   reading `ref.current` during render at all, not just writing it; state is the
   idiomatic substitute for a value written from an event/effect callback and read
   during render — found and fixed during Phase 1's implementation, see
   `TimelineStage.tsx`'s own doc comment). When computing the `tracks` prop, if the
   current `tracks` prop is reference-equal to the cached `dehydrated` value, return
   the cached `raw` value unchanged instead of calling `hydrate()` — restores
   `isEngineTracks` for the exact render caused by that engine-driven commit. Falls
   through to `hydrate()` for any other commit (move, duplicate, delete, add/remove
   track, undo/redo), correctly, with no manual invalidation needed (the reference
   just won't match).
2. **Per-track memoized `hydrate()`**: `WeakMap<TrackMeta-track-object, ClipTrack>` —
   only rebuilds a track's hydrated form when that specific track object's reference
   changed. Restores `isIncrementalAdd`'s per-track check for `addTrack`
   (`[...prev, newTrack]` leaves all existing track objects untouched) and gives the
   same benefit to `duplicateClip`/`deleteClip` (which already only replace the one
   affected track's object via `.map()`, per `useClipActions.ts`'s current code).

Verify in Phase 1 specifically: trim, split, and add-track should **not** trigger a
full engine rebuild; cross-track/same-track move, duplicate, delete, undo, redo still
legitimately should (matches today's behavior for moves, extends it — by design — to
the other two).

**Automated-detection gotcha found while building this (see `e2e/helpers.ts`'s
`rebuildsEngine` doc comment): don't use the "Building waveform…" placeholder text as
the automated signal for "did a rebuild happen."** It's a fine signal for a human
watching a real, slow rebuild (large session, cold module cache), but for a small
synthetic test clip over an already-warm dynamic-import cache (true for every rebuild
after the first on a given page load), the engine's internal `resolvePlayoutAdapter()`
resolves via a microtask fast enough that React can batch the `isReady` false→true
transition without ever committing an observably separate "not ready" DOM state —
confirmed empirically (a MutationObserver watching for the placeholder text never
fired across a rebuild that other evidence confirmed did happen). The reliable signal
is the library's own `window` CustomEvent `"waveform-playlist:ready"` (confirmed in
`@waveform-playlist/browser/dist/index.js` — dispatched exactly once, at the end of
the full-rebuild `loadAudio()` path, never on the `isEngineTracks`/`isIncrementalAdd`
skip-rebuild paths, which return early before reaching it). `rebuildsEngine()` in
`e2e/helpers.ts` listens for this event; use it for any future test that needs to
assert whether a mutation caused a full rebuild.

## Phased implementation

### Phase 0 — Committed test harness

No test suite is committed today (per `CLAUDE.md`); all verification so far has
been ad-hoc `playwright-core` scripts written fresh in the session scratchpad each
time. That was a reasonable way to probe a proof-of-concept; it stops being
reasonable once undo/redo and persistence exist, since every later feature
(fades, export, effects) risks silently regressing them and nothing would catch it
without a full manual re-pass. Do this first so Phases 1-3 each *extend* a real
suite instead of writing another disposable script.

New:
- `@playwright/test` as a devDependency (not `playwright-core` — the test-runner
  package, with its own test discovery/reporting, replacing the scratchpad
  harness).
- `playwright.config.ts` — `webServer` config running `npm run build && npm run start`
  (prod build, not `next dev`; this project's own established finding is that
  dev-mode Turbopack/Strict-Mode double-invocation was ruled out as a bug source,
  and prod-build testing is the signal that's been reliable so far).
- `e2e/` directory:
  - `e2e/fixtures.ts` — the synthetic-WAV-generation helper (raw PCM sine wave, 44-byte
    RIFF header) already established as this project's approach, promoted from
    scratchpad script to a shared, reusable fixture.
  - `e2e/helpers.ts` — shared selectors/waits: `data-testid="current-time"`/
    `"total-duration"`, `[data-clip-id]:not([data-boundary-edge])` for the
    draggable clip element, a `waitForWaveformReady()` helper that waits for
    "Building waveform…" to detach, and (added during Phase 1) `rebuildsEngine()`
    — the authoritative "did this action cause a full engine rebuild" signal,
    via the library's `"waveform-playlist:ready"` window event, not the
    placeholder text (see the gotcha noted in "Confirmed library behavior" above).
  - `e2e/playback.spec.ts` — first committed test, a smoke test porting the
    existing single-file and multi-clip playback verification (import, play,
    seek, zoom) — proves the harness itself works before Phase 1 adds anything
    behind it.
- `package.json` — `"test:e2e": "playwright test"` script.

Each later phase's "Verify" step below means: **extend this suite**, don't spin up
another throwaway script. The one exception already called out in CLAUDE.md is the
play()/rebuild race and its sibling (playing-while-editing) — both are documented
there as not reliably reproducible under Playwright even with CPU throttling; the
new playback-guards this plan adds (duplicate/delete/undo/redo while playing)
should get a committed regression test for the *guard's effect* (stop() was called,
no crash), same as the existing ones, while still being disclosed as "correct by
inspection, not proven under adversarial timing" per CLAUDE.md's own standard.

### Phase 1 — Metadata/hydration boundary (no history, no persistence)

New files:
- `audio-engine/persistence/types.ts` — `ClipMeta`/`TrackMeta`.
- `audio-engine/persistence/assetRegistry.ts` — as above (content-hash `assetId`, registry is a
  pure buffer↔id lookup table, never mints an id itself).
- `audio-engine/persistence/clipHydration.ts` — `hydrate`/`dehydrate` + the two caches above.

Modified:
- `audio-engine/useTimelineTracks.ts` — state becomes `TrackMeta[]`; `addFilesToTrack`
  still decodes via `decodeAudioData`, but first hashes the file's raw bytes
  (`crypto.subtle.digest("SHA-256", arrayBuffer)`, hex-encoded) to mint `assetId`
  *before* decoding (see the detachment gotcha above), then
  `registerAsset(audioBuffer, assetId)`, then builds a `ClipMeta` (no `audioBuffer`).
- `audio-engine/useClipActions.ts` — operates on `ClipMeta`; duplicate's spread
  carries `assetId` over unchanged (same asset, no registry interaction needed).
- `timeline/TimelineStage.tsx` — becomes the sole choke point: memoized `hydrate(tracks)`
  for the `tracks` prop (with the passthrough cache), `dehydrate()` wrapping whatever
  `onTracksChange` does before it reaches state.
- `PodcastEditor.tsx` — no logic change, now deals exclusively in `TrackMeta[]`.

Unchanged: `ClipDragLayer.tsx`, `ClipActionsOverlay.tsx`, `useScissorsSplit.ts`,
`clipGeometry.ts`, `EditorShell.tsx`, `TransportControls.tsx`, `PlayButton.tsx`.

**Verify** (extends the Phase 0 suite): full pass through every existing feature
(import, same-track drag, cross-track drag, trim, split, duplicate, delete,
add/remove track, playback, zoom). Confirm the "no spurious rebuild" cases above.

**Status: implemented and committed** (`e2e/hydration.spec.ts`, 7 tests). Using
`rebuildsEngine()` (see above), committed coverage confirms: add-track and boundary
trim (dragging a `data-boundary-edge` handle) and split do **not** rebuild;
duplicate, delete, same-track drag, and cross-track drag **do** rebuild — every
mutation type called out in this section, all via real `page.mouse` pointer-drag
sequences for the drag/trim cases (not `locator.dragTo()`, which emulates HTML5 DnD —
a different mechanism than dnd-kit's `PointerSensor`). `tsc --noEmit` and `eslint`
are clean; the full suite (this file + `playback.spec.ts`, 9 tests) passed
repeatedly against a fresh prod build with no flake observed across multiple runs.

The cross-upload asset-dedup case (uploading the same synthetic file twice, via two
separate "Upload clip" actions, and confirming both clips resolve to the same
`assetId`) is deferred to Phase 3, where it's actually observable end-to-end (only
one record written to IndexedDB for that content hash) — there's no way to assert
it from the DOM alone before persistence exists.

### Phase 2 — Undo/redo via Zustand (still no persistence)

Zustand store (`audio-engine/persistence/projectStore.ts`):
```ts
interface HistoryEntry { label: string; before: TrackMeta[]; after: TrackMeta[]; }
interface ProjectStoreState {
  present: TrackMeta[];
  past: HistoryEntry[];
  future: HistoryEntry[];
  // `update` computes `next` from whatever `present` *actually is* at the moment
  // this action runs — never from a value the caller captured earlier. See
  // "Stale-closure rule" below for why this is the signature, not `(next, label)`.
  commit: (update: (prev: TrackMeta[]) => TrackMeta[], label: string) => void;
  undo: () => void;
  redo: () => void;
  replacePresent: (tracks: TrackMeta[]) => void; // non-history-pushing; used by Phase 3's load-on-mount only
}
```
`commit`/`undo`/`redo`/`replacePresent` must be **fully synchronous** (plain `set()`
calls, no `await` inside the action) — this codebase has already hit two races from
a check-then-act split across an `await` (the `play()`/rebuild race, the
`resumePlayback` race, both in CLAUDE.md); don't introduce a third.

**Stale-closure rule (found in review of this plan's first draft, fixed here):**
the first draft had `commit(next: TrackMeta[], label: string)` — a materialized
array, not a function. That reintroduces exactly the class of bug the "fully
synchronous" rule above is trying to prevent, just one layer up: `addFilesToTrack`
is async (decode happens before any commit), so if it closes over a `present` value
read *before* the `await`, and some other mutation (a drag, another import) commits
*during* that decode, the eventual `commit(next, ...)` call would silently revert
it — a real check-then-act split, just spanning a React callback instead of a
`set()` call. Today's plain `useState`-based `setTracks(prev => ...)` avoids this
for free via React's functional-update pattern; a plain-array `commit` API throws
that safety away. Fixed by making `commit` always take an updater function — the
store applies it to `get().present` *inside* the synchronous `set()` call, so
`prev` is always whatever's true at the instant the commit actually executes, not
whatever was true when the caller decided to call it. Every caller uses this form
now, even ones with no `await` in front of them (e.g. `TimelineStage.tsx`'s
engine-driven commits become `commit(() => dehydrated, "Edit timeline")`) — one
signature, no path that can accidentally pass a stale snapshot.

New files:
- `audio-engine/persistence/projectStore.ts` — as above.
- `audio-engine/persistence/useUndoRedoShortcut.ts` — keydown listener mounted from
  `EditorShell.tsx` (inside the provider tree). Wires Ctrl/Cmd+Z and
  Ctrl/Cmd+Shift+Z to `store.undo()`/`store.redo()`, gated on `isReady` (same
  signal already gating `TransportControls`). **Do not** enable the library's own
  `undo?: boolean` shortcut prop or call `usePlaylistControls().undo/redo` —
  confirmed via `@waveform-playlist/browser/dist/index.d.ts` that this is a
  separate, opt-in mechanism (defaults off, not currently used anywhere in this
  app) that only covers engine-internal transactions; wiring both would mean two
  competing Ctrl+Z listeners.
- `transport/UndoRedoButtons.tsx` — reads `useProjectStore` directly, rendered
  inside `TransportControls.tsx`. Inherits the existing `pointer-events-none
  opacity-50` `!isReady` gating for free, since it renders inside the same wrapped
  block `EditorShell.tsx` already wraps `TransportControls` in.

**Playback guard extension (confirmed decision):** extend the existing "stop
playback before a rebuild-triggering mutation" guard (today only in
`ClipDragLayer.tsx`'s `onDragEnd`) to duplicate/delete and undo/redo — closing a
real pre-existing gap (duplicate/delete during playback can already hit the
documented `TonePlayout not initialized` crash today, independent of this work,
since they already go through a full rebuild via plain `setTracks`).
- `clip-menu/ClipActionsOverlay.tsx` — pull in `usePlaybackAnimation().isPlaying`
  and `usePlaylistControls().stop()` (both already used elsewhere in this codebase,
  e.g. `ClipDragLayer.tsx`); call `stop()` before invoking `onDuplicateClip`/
  `onDeleteClip` when `isPlaying`. This is the right place for the guard (not
  `useClipActions.ts` itself) because that hook is owned by `PodcastEditor.tsx`,
  outside the provider tree, and structurally can't reach `stop()`/`isPlaying` —
  `ClipActionsOverlay` already lives inside the tree and already calls these props.
- `useUndoRedoShortcut.ts` / `UndoRedoButtons.tsx` — same `stop()`-if-`isPlaying`
  check before calling `store.undo()`/`redo()` (both the keyboard path and the
  button-click path need it independently).

Modified:
- `useTimelineTracks.ts` — reads/writes go through `useProjectStore` (`present`,
  `commit(update, label)`) instead of local `useState`; each action passes a
  descriptive label ("Add track", "Import clips", etc) and an updater function
  (`(prev) => next`), never a value captured before an `await`.
- `useClipActions.ts` — calls `commit((prev) => next, "Duplicate clip"/"Delete clip")`.
- `timeline/TimelineStage.tsx` — its `onTracksChange` wrapper calls
  `commit(() => dehydrate(raw), "Edit timeline")` (one generic label — this is the
  fan-in point for both engine-driven trim/split and `ClipDragLayer`'s hand-applied
  moves, no cheap way to distinguish which one just happened here, and labels are
  cosmetic only).
- `timeline/EditorShell.tsx` — mounts `useUndoRedoShortcut()`.
- `transport/TransportControls.tsx` — renders `<UndoRedoButtons />`.

Known, deliberately-deferred edge cases (disclose in CLAUDE.md once implemented,
don't build around them speculatively):
- History is capped (~100 entries); older entries silently drop.
- `future` clears on every `commit()`, including the generic `TimelineStage` bucket.
- If `undo()`/`redo()` removes the currently-selected track/clip, `EditorShell.tsx`'s
  `selectedTrackId` may point at a now-missing id — worth a defensive check-and-clear
  but not a blocker; existing `effectiveTrackId` fallback already handles `null`,
  just not "stale but non-null".

**Verify** (extends the Phase 0 suite): undo/redo through every mutation type;
confirm `future` clears correctly; confirm buttons/shortcut disable during a
rebuild; confirm playing → duplicate/delete/undo/redo stops playback rather than
crashing. Add a specific race test for the stale-closure fix: start an import
(decode takes nonzero time for a large-enough synthetic file), commit an unrelated
mutation (e.g. add a track) while the import is still in flight, then confirm both
end up reflected in `present` once the import resolves — this is the concrete
scenario the updater-function fix exists for, so it should be the one thing in this
phase that isn't just "correct by inspection." The two playback-guard races
(play()/rebuild, and its "editing while already playing" sibling) stay documented
per CLAUDE.md's existing standard: correct by inspection, not provably safe from an
automated pass alone, since both were already established as unreproducible under
Playwright even with throttling.

### Phase 3 — IndexedDB persistence + initial-load rehydration

`idb` schema (`audio-engine/persistence/persistence.ts`), DB `editor-pro` v1, two stores:
- `project` — single fixed-key record: `{ schemaVersion: 1, tracks: TrackMeta[], updatedAt }`.
  Only the current `present` snapshot — **not** `past`/`future` (undo history doesn't
  need to survive a reload; keeps the record small and sidesteps any asset-GC-vs-
  history-reference questions).
- `assets` — keyed by content-hash `assetId`: `{ blob: Blob, type: string, addedAt }`.
  Holds the **original uploaded File** (already a `Blob`), not the decoded
  `AudioBuffer` — no cheap re-encode path back to a file, and editing here is
  non-destructive so the original stays valid forever. Because the key is a content
  hash (see Phase 1), writing the same file's bytes twice is an idempotent
  overwrite of the same record, not a duplicate — dedup requires no extra logic
  here, it's a property of the key.

Functions: `saveProject(tracks)`, `loadProject()`, `saveAsset(assetId, blob)`,
`loadAsset(assetId)`, `loadAssets(assetIds: string[])` (batched parallel read).

New files:
- `audio-engine/persistence/persistence.ts` — as above.
- `audio-engine/persistence/useProjectHydration.ts` — mount-time effect: `loadProject()` →
  collect every distinct `assetId` referenced by any clip → `loadAssets(...)` →
  `decodeAudioData` each blob → `registerAsset(buffer, assetId)` (the persisted id
  — critical, minting a fresh one here would orphan every `ClipMeta.assetId`) →
  `store.replacePresent(tracks)` → flip `isProjectHydrating` false. Wrapped in
  try/catch: any failure (private-browsing storage block, quota error, corrupt
  record) falls back to the default single-empty-track project and still flips
  `isProjectHydrating` false — never a permanent loading screen.

Unchanged: `audio-engine/persistence/assetRegistry.ts` — Phase 1 already always calls
`registerAsset` with a known id (the content hash), so Phase 3's rehydration path
is just a second caller of the same function with a different (persisted, not
freshly-hashed) known id. No redesign needed here, unlike the first draft of this
plan which had assetRegistry minting ids itself and only optionally accepting a
known one.

Modified:
- `audio-engine/useTimelineTracks.ts` — `addFilesToTrack` also calls
  `saveAsset(assetId, file)` right after hashing, before the original `File`
  would otherwise go out of scope post-decode.
- `PodcastEditor.tsx` — mounts `useProjectHydration()`; shows a loading placeholder
  (same visual language as `PodcastEditorLoader`'s own dynamic-import loading state,
  for a consistent two-stage load) instead of `TimelineStage` while
  `isProjectHydrating` is true; mounts a debounced (~500ms trailing-edge) persistence
  effect subscribed to `present`, armed only *after* hydration completes so the
  just-loaded state doesn't immediately re-trigger a redundant write.

Debounce is about not issuing an IDB write per rapid action (e.g. holding undo) and
avoiding overlapping in-flight writes — not about coalescing continuous input, since
every mutation in this app already only calls `onTracksChange`/`commit` once, at the
settled end-state (drag-end, not per-pointer-move). Asset blobs are written once per
import (deduped for free by content-addressing, see above), no debounce needed.

**Interaction with `PodcastEditorLoader.tsx`**: unchanged — its `ssr:false` boundary
exists purely for Tone.js's `window` touch at module-eval time. `idb`'s `openDB()`
calls happen inside effects, not at module top-level, so no new SSR boundary is
needed — but verify on first implementation that importing `idb` itself doesn't
synchronously touch `window`/`indexedDB` at import time (same class of gotcha as
the already-documented `styled-components` one).

**Verify** (extends the Phase 0 suite): import files, drag, trim, undo once,
`page.reload()`, confirm restored state matches and playback works. Also test a
fresh IndexedDB (new browser context) still renders the default empty project
without hanging, and that an injected failure in the hydration effect falls back
correctly rather than spinning forever. Add the cross-upload-dedup assertion
deferred from Phase 1: upload the same synthetic file twice, reload, and confirm
only one record exists in the `assets` store for that content hash.

## New dependencies

- `@playwright/test` — committed E2E test harness (Phase 0), replacing the
  scratchpad-script pattern.
- `zustand` — history/undo-redo store.
- `idb` (not `localforage` — no need for its legacy storage-fallback layer) — thin
  Promise wrapper over IndexedDB.

## Not in scope for this plan (disclose, don't solve)

- Asset garbage collection (deleting a clip's last reference to an `assetId` leaves
  an orphaned blob in IndexedDB — disk cost, not correctness; content-hash IDs
  reduce how often this happens for *repeated* uploads of the same file, but don't
  eliminate GC as a need once a clip using a once-unique asset is deleted for good).
- Multi-tab sync (IndexedDB is shared per-origin; last write wins, no cross-tab
  awareness).
- Persisting undo history itself across reloads.

## Verification approach

Phase 0 above commits a real Playwright suite (`@playwright/test`, run against
`npm run build && npm run start` — prod build, not `next dev`, per this project's
own established finding that dev-mode Turbopack/Strict Mode double-invocation isn't
representative). Each phase extends that suite rather than writing a disposable
script. It already carries forward the right selectors
(`data-testid="current-time"/"total-duration"`, `[data-clip-id]:not([data-boundary-edge])`
for draggable clips, waiting for "Building waveform…" to detach) and the
synthetic-WAV-generation approach from this project's prior ad-hoc scripts. Treat
the new playback-guard paths (duplicate/delete/undo/redo while playing) the same
way CLAUDE.md already treats the original play/rebuild race: get a committed
regression test for the guard's effect, but disclose the underlying race itself as
correct by inspection, not provably safe from an automated pass alone, since it's
already established as unreproducible under Playwright even with throttling.
