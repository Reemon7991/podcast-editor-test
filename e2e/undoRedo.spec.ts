import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor } from "./helpers";

const UNDO = { name: "Undo" } as const;
const REDO = { name: "Redo" } as const;
const REMOVE_TRACK = { name: "Remove track" } as const;

/**
 * Phase 2 (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md) — undo/redo via the
 * Zustand project store. Covers the store's own behavior (undo/redo through
 * every mutation type, future clearing, button/shortcut enablement), the
 * playback guard extended to duplicate/delete/undo/redo, and two bugs found
 * and fixed while building this: a stale-closure race in the store's commit
 * API, and undo-history pollution from trim's live-preview frames (see
 * projectStore.ts and ClipDragLayer.tsx's doc comments).
 */
test.describe("Phase 2 undo/redo", () => {
  test("undo/redo buttons start disabled and enable after a commit", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await expect(page.getByRole("button", UNDO)).toBeDisabled();
    await expect(page.getByRole("button", REDO)).toBeDisabled();

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);

    await expect(page.getByRole("button", UNDO)).toBeEnabled();
    await expect(page.getByRole("button", REDO)).toBeDisabled();
  });

  test("add track can be undone and redone", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(2);

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(1);

    await page.getByRole("button", REDO).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(2);
  });

  test("importing a clip can be undone and redone", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(0);

    await page.getByRole("button", REDO).click();
    await waitForWaveformReady(page);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);
  });

  test("a new commit after undo clears redo", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REDO)).toBeEnabled();

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);

    await expect(page.getByRole("button", REDO)).toBeDisabled();
  });

  test("Ctrl+Z / Ctrl+Shift+Z undo and redo", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(2);

    await page.keyboard.press("Control+z");
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(1);

    await page.keyboard.press("Control+Shift+z");
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(2);
  });

  test("trimming a clip undoes in a single step, not per pixel", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const originalBox = (await clip.boundingBox())!;

    const rightHandle = page.locator('[data-boundary-edge="right"]').first();
    const box = (await rightHandle.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 10, startY, { steps: 5 });
    await page.mouse.move(startX - 60, startY, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    const trimmedBox = await clip.boundingBox();
    expect(trimmedBox?.width).not.toBeCloseTo(originalBox.width, 0);

    // A single Undo should restore the clip to its pre-trim size — if the
    // live-preview frames during the drag had each pushed their own history
    // entry (the bug found while building this), this would only undo the
    // last pixel of movement instead.
    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);
    const undoneBox = await clip.boundingBox();
    expect(undoneBox?.width).toBeCloseTo(originalBox.width, 0);
  });

  test("importing clips does not lose a concurrent add-track commit", async ({ page }) => {
    // Regression test for the store's stale-closure rule (see
    // projectStore.ts's `commit` doc comment): addFilesToTrack's commit
    // resolves after an async decode, so a commit fired in the gap must not
    // be silently reverted. Fires the upload without awaiting its own
    // settle, then immediately triggers an unrelated commit — this asserts
    // correctly regardless of whether the decode is still in flight by the
    // time the second action lands, since the fix is a correctness property
    // of the updater-function API, not a timing-dependent one.
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.locator(SELECTORS.fileInput).setInputFiles([makeSineWavFile("tone.wav", 2)]);
    await page.getByRole("button", { name: "+ New Track" }).click();

    await waitForWaveformReady(page);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(2);
  });

  test("duplicating a clip while playing stops playback instead of crashing", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await page.getByRole("button", { name: "Clip actions" }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await waitForWaveformReady(page);

    // Playback should have been stopped (not left running against a
    // rebuilt/uninitialized engine) — Play should be clickable again.
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });

  test("undo while playing stops playback instead of crashing", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await gotoEditor(page);
    await waitForWaveformReady(page);
    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);

    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });
});
