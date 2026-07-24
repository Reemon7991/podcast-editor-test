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
