import { test, expect, type Page } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, rebuildsEngine, gotoEditor } from "./helpers";

const PLAY = { name: "Play", exact: true } as const;
// PlayPauseButton (UI-UX-redesign) merged the old separate Play/Pause
// buttons into one toggle whose accessible name flips with isPlaying —
// unlike the old PlayButton, it's never `disabled` while playing (it has to
// stay clickable so a second click can pause). "Pause" becoming visible is
// this toggle's own signal that play() actually resolved and isPlaying
// flipped true, replacing the old "Play button is disabled" check.
const PAUSE = { name: "Pause", exact: true } as const;
const UNDO = { name: "Undo" } as const;

/**
 * Fade in/out (see the fade-feature plan) — draggable circle handles
 * (FadeHandles.tsx/useFadeDragHandlers.ts), hover-revealed via
 * ClipActionsOverlay.tsx's existing hover-tracking.
 *
 * The key architectural fact this suite pins down as a regression test:
 * unlike trim, there is no engine-native fade primitive
 * (@waveform-playlist/engine only exposes splitClip/trimClip/moveClip), so a
 * committed fade edit *always* forces a full engine rebuild — the same cost
 * class as a completed clip move, never the rebuild-free path trim gets via
 * `isEngineTracks`. "dragging a fade handle rebuilds the engine" below
 * exists specifically so a future session can't silently "fix" this into a
 * visual/audio mismatch (see useFadeDragHandlers.ts's own doc comment for
 * why faking isDraggingRef to suppress the rebuild would be worse, not
 * better).
 *
 * Because a fade commit rebuilds the engine, it also unmounts/remounts
 * ClipDragLayer/ClipActionsOverlay's subtree (same as any other
 * rebuild-triggering mutation) — every test below re-hovers the clip after
 * each waitForWaveformReady() that follows a real commit, since hover state
 * is local component state that doesn't survive that remount.
 */

/** The handle circle is centered on its logical position via CSS
 *  `transform: translate(-50%, -50%)` (FadeHandles.tsx) — its own bounding
 *  box is offset by half its size from that point, so every comparison
 *  below (click targets and position assertions alike) uses the box's
 *  center, not its raw x/y corner. */
function centerOf(box: { x: number; y: number; width: number; height: number }) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function fadeInHandleCenter(page: Page) {
  const box = (await page.locator(SELECTORS.fadeInHandle).first().boundingBox())!;
  return centerOf(box);
}

test.describe("Fade in/out", () => {
  test("fade handles are hidden by default, appear on hover", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    await expect(page.locator(SELECTORS.fadeInHandle)).toHaveCount(0);
    await expect(page.locator(SELECTORS.fadeOutHandle)).toHaveCount(0);

    await page.locator(SELECTORS.draggableClip).first().hover();

    await expect(page.locator(SELECTORS.fadeInHandle)).toHaveCount(1);
    await expect(page.locator(SELECTORS.fadeOutHandle)).toHaveCount(1);
  });

  test("dragging a fade handle rebuilds the engine", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    const start = await fadeInHandleCenter(page);

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 40, start.y, { steps: 10 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(true);
  });

  test("a completed fade drag undoes in one step", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    const clipBox = (await clip.boundingBox())!;
    const start = await fadeInHandleCenter(page);
    // No fade set yet — the handle starts right at the clip's own left edge.
    // Precision -1 (not 0): globals.css's [data-clip-container] border (added
    // in the UI-UX-redesign pass) shifts the clip's own rendered bounding box
    // by its border-width, which the handle's independently-computed
    // sample-based position doesn't share — a few px of slack absorbs that
    // constant offset without loosening the check's actual intent.
    expect(start.x).toBeCloseTo(clipBox.x, -1);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 50, start.y, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    await clip.hover();
    const dragged = await fadeInHandleCenter(page);
    expect(dragged.x).toBeGreaterThan(clipBox.x + 30);

    // A single Undo should restore the handle to its pre-drag position — if
    // this fed live-preview frames into undo history the way an early
    // trim-drag bug once did (see projectStore.ts/CLAUDE.md), it wouldn't.
    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);

    await clip.hover();
    const undone = await fadeInHandleCenter(page);
    // Precision -1, same reasoning as this test's own pre-drag check above.
    expect(undone.x).toBeCloseTo(clipBox.x, -1);
  });

  test("Escape cancels a fade drag without committing", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    const start = await fadeInHandleCenter(page);

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + 50, start.y, { steps: 10 });
      await page.keyboard.press("Escape");
      await page.mouse.up();
    });

    // Nothing was ever committed, so no rebuild — and the clip's hover state
    // survives (no remount), so re-hovering isn't needed to check position.
    expect(rebuilt).toBe(false);
    const after = await fadeInHandleCenter(page);
    expect(after.x).toBeCloseTo(start.x, 0);
  });

  test("dragging a fade handle back to the corner clears the fade", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    const start = await fadeInHandleCenter(page);
    const originX = start.x;

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 50, start.y, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    await clip.hover();
    const grown = await fadeInHandleCenter(page);
    await page.mouse.move(grown.x, grown.y);
    await page.mouse.down();
    await page.mouse.move(originX, grown.y, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    await clip.hover();
    const final = await fadeInHandleCenter(page);
    expect(final.x).toBeCloseTo(originX, 0);
  });

  test("dragging a fade handle while playing stops playback instead of crashing", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    await page.getByRole("button", PLAY).click();
    await expect(page.getByRole("button", PAUSE)).toBeVisible();

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    const start = await fadeInHandleCenter(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 40, start.y, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    // Playback should have been stopped (not left running against a
    // rebuilt/uninitialized engine) — Play should be clickable again.
    await expect(page.getByRole("button", PLAY)).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });
});
