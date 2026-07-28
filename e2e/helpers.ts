import type { Page } from "@playwright/test";
import type { UploadFile } from "./fixtures";

/**
 * Shared selectors, established across this project's prior ad-hoc
 * verification passes (see CLAUDE.md's "Verification approach" and
 * PERSISTENCE_UNDO_ORIGINAL_PLAN.md's Phase 0) and now promoted here so
 * every spec references the same source of truth instead of re-deriving it.
 */
export const SELECTORS = {
  currentTime: '[data-testid="current-time"]',
  totalDuration: '[data-testid="total-duration"]',
  /** The clip's header bar — not the waveform <canvas>, not the
   *  data-boundary-edge="left"|"right" trim handles. */
  draggableClip: "[data-clip-id]:not([data-boundary-edge])",
  fileInput: 'input[type="file"]',
  /** FadeHandles.tsx's draggable circles — only mounted while a clip is
   *  hovered/fade-drag-locked (see ClipActionsOverlay.tsx), never present
   *  in the DOM otherwise. */
  fadeInHandle: '[data-fade-handle="in"]',
  fadeOutHandle: '[data-fade-handle="out"]',
} as const;

/**
 * Every accepted clip move/duplicate/delete/undo/redo triggers a full Tone.js
 * engine rebuild, during which EditorShell.tsx swaps the waveform for a
 * "Building waveform…" placeholder and disables the transport bar. Waiting
 * for this text to be hidden (not just "not visible now") is the one signal
 * that's reliable across every mutation in this app, per CLAUDE.md.
 *
 * `waitFor({ state: "hidden" })` also resolves immediately if the locator
 * currently matches zero elements — i.e. this is safe to call even when the
 * placeholder never appeared at all (e.g. immediately after initial load, if
 * the very first empty-track build already finished), not just after it's
 * been removed.
 */
export async function waitForWaveformReady(page: Page) {
  // Phase 3 added an async IndexedDB hydration step (useProjectHydration.ts)
  // that runs before TimelineStage — and its "Building waveform…"
  // placeholder — ever mounts. Without waiting for the earlier "Loading
  // project…" placeholder first, this could resolve while still on that
  // pre-mount screen (zero "Building waveform…" matches is trivially true
  // there too), then the caller would go on to interact with elements
  // (upload input, "+ New Track") that don't exist yet. Same
  // waitFor({state:"hidden"}) safety as below applies here too: resolves
  // immediately if hydration was already fast enough that this text never
  // appeared at all.
  await page.getByText("Loading project…").waitFor({ state: "hidden" });
  await page.getByText("Building waveform…").waitFor({ state: "hidden" });
}

type RebuildProbeWindow = { __rebuildCount: number };

/**
 * Navigates to the editor with a `"waveform-playlist:ready"` counter installed
 * via `page.addInitScript` — i.e. wired up before any of the page's own
 * scripts run, so it's guaranteed to catch the very first rebuild (the
 * initial mount) with no race window. Use this instead of a bare
 * `page.goto("/")` in any test that will later call `rebuildsEngine()`.
 *
 * This matters because the DOM-visible "Building waveform…" placeholder
 * clearing (what `waitForWaveformReady` watches) and the library's own
 * `"waveform-playlist:ready"` CustomEvent dispatch are not strictly ordered
 * relative to each other — confirmed empirically (dispatch was observed
 * firing a few hundred ms *after* the placeholder had already cleared, for
 * the initial mount's own build). A `rebuildsEngine()` call that attached its
 * listener fresh right after `waitForWaveformReady()` resolved could catch
 * that late-arriving *initial-mount* event and misattribute it to whatever
 * action ran immediately after — exactly what happened here initially: the
 * "adding a track does not rebuild" test has no other async work between
 * page load and the action to absorb that race, so it saw the leftover
 * initial-mount event and reported a false rebuild. Counting from before
 * first navigation removes the race entirely: `rebuildsEngine()` only ever
 * compares a before/after snapshot of one continuously-running counter.
 */
export async function gotoEditor(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as RebuildProbeWindow).__rebuildCount = 0;
    window.addEventListener("waveform-playlist:ready", () => {
      (window as unknown as RebuildProbeWindow).__rebuildCount += 1;
    });
  });
  await page.goto("/");
}

/**
 * Uploads via the hidden file input directly (Playwright's setInputFiles
 * doesn't require the target to be visible), rather than clicking the
 * "Upload clip" button — the button/input pair sit inside the same
 * pointer-events-none wrapper EditorShell.tsx disables during a rebuild, so
 * driving the input directly is both simpler and avoids fighting that guard
 * for a case it isn't meant to protect against here.
 */
export async function uploadFiles(page: Page, files: UploadFile[]) {
  await waitForWaveformReady(page);
  await page.locator(SELECTORS.fileInput).setInputFiles(
    files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer: f.buffer }))
  );
  await waitForWaveformReady(page);
}

/**
 * Runs `action`, and reports whether it caused a full Tone.js engine
 * dispose+rebuild — used to assert Phase 1's hydrate()/dehydrate() caches
 * (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Confirmed library behavior"
 * section): trim/split/add-track must NOT rebuild; move/duplicate/delete/
 * undo/redo still legitimately do.
 *
 * Compares a before/after snapshot of the counter `gotoEditor()` installs
 * (see its doc comment for why this is a snapshot-diff rather than a fresh
 * attach/detach per call — the latter has a real race against the initial
 * mount's own rebuild event). **Requires the page to have been navigated via
 * `gotoEditor()`, not a bare `page.goto("/")`.**
 *
 * Listens for the library's own `window` CustomEvent
 * `"waveform-playlist:ready"` (confirmed in
 * @waveform-playlist/browser/dist/index.js — dispatched exactly once, at the
 * end of the full-rebuild `loadAudio()` path, never on the
 * isEngineTracks/isIncrementalAdd skip-rebuild paths, which return early
 * before reaching it) — NOT the "Building waveform…" placeholder text.
 *
 * That placeholder was the first thing tried here and turned out to be an
 * unreliable signal in this test environment: for a small synthetic clip
 * over an already-warm dynamic-import module cache (true for every rebuild
 * after the very first on a given page load), `resolvePlayoutAdapter()`'s
 * internal `import()` resolves via a microtask rather than a real
 * network/parse delay, fast enough that React can batch the
 * isReady:false→true transition without ever committing an observably
 * separate "not ready" DOM state — confirmed empirically (a MutationObserver
 * watching for the placeholder text never fired across a rebuild that the
 * `waveform-playlist:ready` event confirmed did happen). The placeholder is
 * still a legitimate signal for a human watching a real, slow rebuild
 * (large session, cold cache) — it's specifically unreliable as an
 * *automated* detector against small synthetic fixtures like these.
 */
export async function rebuildsEngine(page: Page, action: () => Promise<void>): Promise<boolean> {
  // The initial mount's own "waveform-playlist:ready" dispatch is not
  // strictly ordered relative to the "Building waveform…" placeholder
  // clearing (see gotoEditor's doc comment) — it can arrive up to a few
  // hundred ms *after* waitForWaveformReady() already resolved. A test that
  // calls rebuildsEngine() immediately after gotoEditor()/
  // waitForWaveformReady() with no other action in between (e.g. "adding a
  // track does not rebuild the engine", the one test with no buffer time to
  // absorb this) can read `before` while that event is still in flight,
  // then have it land *during* the action's own wait window instead,
  // producing a false "rebuilt: true". Waiting here for the counter to have
  // ticked at least once — the initial mount always goes through a full
  // rebuild, so it always fires exactly once — guarantees that leftover
  // event has already landed before `before` is captured, for every caller,
  // not just ones that happen to have an intervening action already.
  await page.waitForFunction(
    () => (window as unknown as RebuildProbeWindow).__rebuildCount >= 1
  );
  const before = await page.evaluate(() => (window as unknown as RebuildProbeWindow).__rebuildCount);

  await action();
  await waitForWaveformReady(page);
  // Give React/the engine one more tick to finish in case the event lands
  // just after `action`'s own promise resolves.
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => (window as unknown as RebuildProbeWindow).__rebuildCount);
  return after > before;
}
