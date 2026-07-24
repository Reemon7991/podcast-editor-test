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
  await page.getByText("Building waveform…").waitFor({ state: "hidden" });
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

type RebuildProbeWindow = {
  __rebuildCount: number;
  __rebuildListener?: EventListener;
};

/**
 * Runs `action`, and reports whether it caused a full Tone.js engine
 * dispose+rebuild — used to assert Phase 1's hydrate()/dehydrate() caches
 * (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Confirmed library behavior"
 * section): trim/split/add-track must NOT rebuild; move/duplicate/delete/
 * undo/redo still legitimately do.
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
  await page.evaluate(() => {
    const w = window as unknown as RebuildProbeWindow;
    w.__rebuildCount = 0;
    const listener: EventListener = () => {
      w.__rebuildCount += 1;
    };
    window.addEventListener("waveform-playlist:ready", listener);
    w.__rebuildListener = listener;
  });

  await action();
  await waitForWaveformReady(page);
  // Give React/the engine one more tick to finish in case the event lands
  // just after `action`'s own promise resolves.
  await page.waitForTimeout(200);

  return page.evaluate(() => {
    const w = window as unknown as RebuildProbeWindow;
    if (w.__rebuildListener) {
      window.removeEventListener("waveform-playlist:ready", w.__rebuildListener);
    }
    return w.__rebuildCount > 0;
  });
}
