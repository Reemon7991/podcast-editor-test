import { test, expect, type Page } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor, rebuildsEngine } from "./helpers";

const UNDO = { name: "Undo" } as const;
const PLAY = { name: "Play", exact: true } as const;
// PlayPauseButton (UI-UX-redesign) merged the old separate Play/Pause
// buttons into one toggle whose accessible name flips with isPlaying —
// unlike the old PlayButton, it's never `disabled` while playing (it has to
// stay clickable so a second click can pause). "Pause" becoming visible is
// this toggle's own signal that play() actually resolved and isPlaying
// flipped true, replacing the old "Play button is disabled" check.
const PAUSE = { name: "Pause", exact: true } as const;
const SWAP = { name: "Swap" } as const;
const CANCEL = { name: "Cancel" } as const;
const SWAP_DIALOG = { name: "Confirm clip reorder" } as const;

/**
 * Restoring the blocking/constrained drag default (see CLAUDE.md's "Clip
 * swap confirmation" section) plus the new same-track swap-confirm popover.
 * Two contiguous clips (2s + 4s) let a small drag in either direction
 * guarantee an overlap with the sole neighbor, without needing precise
 * sample math.
 */
async function uploadTwoContiguousClips(page: Page) {
  await uploadFiles(page, [
    makeSineWavFile("a.wav", 2),
    makeSineWavFile("b.wav", 4),
  ]);
}

// The swap trigger is driven by where the pointer actually lands (see
// ClipDragLayer.tsx's findSameTrackNeighborAtPointer), not by whether the
// dragged clip's own computed span reaches into a neighbor — so triggering
// a swap in a test means dragging the pointer onto the neighbor's own
// center, not just nudging the source clip's edge into it.
async function dragClipOnto(
  page: Page,
  source: ReturnType<Page["locator"]>,
  target: ReturnType<Page["locator"]>
) {
  const sourceBox = (await source.boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  const startX = sourceBox.x + sourceBox.width / 2;
  const startY = sourceBox.y + sourceBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + Math.sign(endX - startX) * 10, startY, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 15 });
  await page.mouse.up();
}

/** Drags `source`'s pointer to an absolute (x, y), not another clip's
 *  center — used to land in genuinely empty space. */
async function dragClipToPoint(
  page: Page,
  source: ReturnType<Page["locator"]>,
  targetX: number,
  targetY: number
) {
  const box = (await source.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + Math.sign(targetX - startX) * 10, startY, { steps: 5 });
  await page.mouse.move(targetX, targetY, { steps: 15 });
  await page.mouse.up();
}

/** A move always appends the dragged clip last in its track's array, so
 *  array order shifts after any drag — track a clip by its stable
 *  data-clip-id instead of a locator index once a drag has happened.
 *  `[data-clip-id]` alone also matches the clip's own boundary-edge trim
 *  handles (same attribute, three elements) — excluded the same way
 *  SELECTORS.draggableClip does. */
function clipById(page: Page, id: string) {
  return page.locator(`[data-clip-id="${id}"]:not([data-boundary-edge])`);
}

test.describe("Clip swap confirmation", () => {
  test("dragging a clip into its neighbor's area shows a popover without committing", async ({ page }) => {
    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    const clips = page.locator(SELECTORS.draggableClip);
    const secondClipBox = (await clips.nth(1).boundingBox())!;

    const rebuilt = await rebuildsEngine(page, async () => {
      await dragClipOnto(page, clips.nth(1), clips.nth(0));
    });

    expect(rebuilt).toBe(false);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();
    const afterBox = await clips.nth(1).boundingBox();
    expect(afterBox?.x).toBeCloseTo(secondClipBox.x, -1);
  });

  test("confirming the swap exchanges both clips' positions in one undo step", async ({ page }) => {
    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    const clips = page.locator(SELECTORS.draggableClip);
    const firstBoxBefore = (await clips.nth(0).boundingBox())!;
    const secondBoxBefore = (await clips.nth(1).boundingBox())!;

    await dragClipOnto(page, clips.nth(1), clips.nth(0));
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("button", SWAP).click();
    });
    expect(rebuilt).toBe(true);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();

    // clips.nth() reflects array/DOM order, not screen position — the swap
    // only changes startSample, never the array order — so read visual
    // left-to-right order by sorting on x instead of assuming nth(0) is
    // leftmost. The dragged (originally second, 4s) clip now sits first; the
    // other (originally first, 2s) clip now sits right after it —
    // contiguous, not overlapping, and in the opposite order from before.
    const [swappedFirst, swappedSecond] = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
    ].sort((a, b) => a.x - b.x);
    expect(swappedFirst.x).toBeCloseTo(firstBoxBefore.x, -1);
    expect(swappedFirst.width).toBeCloseTo(secondBoxBefore.width, -1);
    expect(swappedSecond.width).toBeCloseTo(firstBoxBefore.width, -1);
    expect(swappedSecond.x).toBeCloseTo(swappedFirst.x + swappedFirst.width, -1);

    // One Undo restores the original order/positions — not two separate steps.
    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);
    const [undoneFirst, undoneSecond] = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
    ].sort((a, b) => a.x - b.x);
    expect(undoneFirst.x).toBeCloseTo(firstBoxBefore.x, -1);
    expect(undoneFirst.width).toBeCloseTo(firstBoxBefore.width, -1);
    expect(undoneSecond.x).toBeCloseTo(secondBoxBefore.x, -1);
    expect(undoneSecond.width).toBeCloseTo(secondBoxBefore.width, -1);
  });

  test("confirming a swap while playing stops playback instead of crashing", async ({ page }) => {
    // Regression test: confirmPendingSwap used to call flushSync(stop) and
    // onTracksChange from *inside* setPendingSwap's updater callback — a
    // React rules-of-updaters violation only reachable while isPlaying is
    // true (this exact path), same class of bug useFadeDragHandlers.ts
    // already found and fixed once. Untested until now, since every other
    // swap test confirms while paused.
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    await page.getByRole("button", PLAY).click();
    await expect(page.getByRole("button", PAUSE)).toBeVisible();

    const clips = page.locator(SELECTORS.draggableClip);
    await dragClipOnto(page, clips.nth(1), clips.nth(0));
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();

    await page.getByRole("button", SWAP).click();
    await waitForWaveformReady(page);

    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();
    // Playback should have been stopped (not left running against a
    // rebuilt/uninitialized engine) — Play should be clickable again.
    await expect(page.getByRole("button", PLAY)).toBeEnabled();
    expect(pageErrors).toEqual([]);
  });

  test("declining (Cancel) leaves the clip exactly where it started", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    const clips = page.locator(SELECTORS.draggableClip);
    const secondBoxBefore = (await clips.nth(1).boundingBox())!;

    const rebuilt = await rebuildsEngine(page, async () => {
      await dragClipOnto(page, clips.nth(1), clips.nth(0));
      await page.getByRole("button", CANCEL).click();
    });

    expect(rebuilt).toBe(false);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();
    const afterBox = (await clips.nth(1).boundingBox())!;
    expect(afterBox.x).toBeCloseTo(secondBoxBefore.x, -1);
    expect(afterBox.width).toBeCloseTo(secondBoxBefore.width, -1);
    expect(pageErrors).toHaveLength(0);
  });

  test("dropping in empty space near a neighbor is a normal move, not a swap, even if the clip's own span reaches into it", async ({ page }) => {
    // Regression test: the swap trigger used to be based on whether the
    // dragged clip's own computed span (from its left edge) overlapped a
    // neighbor — a long clip dropped in genuine empty space could still
    // trigger the popover just because it was long enough to reach into a
    // neighbor once placed. Fixed to check where the pointer itself landed
    // (findSameTrackNeighborAtPointer) instead. Landing in empty space here
    // must fall through to the existing block/clamp handling, unchanged.
    await gotoEditor(page);
    await uploadFiles(page, [
      makeSineWavFile("a.wav", 1),
      makeSineWavFile("b.wav", 1),
      makeSineWavFile("c.wav", 3),
    ]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(3);
    const idA = (await clips.nth(0).getAttribute("data-clip-id"))!;
    const idB = (await clips.nth(1).getAttribute("data-clip-id"))!;
    const idC = (await clips.nth(2).getAttribute("data-clip-id"))!;
    const aBoxOriginal = (await clipById(page, idA).boundingBox())!;

    // Move b far to the right to open up a real gap.
    const bBox = (await clipById(page, idB).boundingBox())!;
    const cBoxInitial = (await clipById(page, idC).boundingBox())!;
    const farX = cBoxInitial.x + cBoxInitial.width + 600;
    await dragClipToPoint(page, clipById(page, idB), farX, bBox.y + bBox.height / 2);
    await waitForWaveformReady(page);

    const bBoxAfterMove = (await clipById(page, idB).boundingBox())!;
    const cBox = (await clipById(page, idC).boundingBox())!;

    // Drop c's pointer well short of b's start (empty space) — c's own 3s
    // width, grabbed at its center, still reaches past that point into b.
    const targetX = bBoxAfterMove.x - cBox.width * 0.3;
    const targetY = cBox.y + cBox.height / 2;
    expect(targetX).toBeLessThan(bBoxAfterMove.x); // sanity: still short of b

    const rebuilt = await rebuildsEngine(page, async () => {
      await dragClipToPoint(page, clipById(page, idC), targetX, targetY);
    });

    expect(rebuilt).toBe(true);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();

    // c landed clamped right after b — a normal move, not a swap. a is
    // untouched (proves this wasn't mistaken for a swap with a either).
    const finalA = (await clipById(page, idA).boundingBox())!;
    const finalB = (await clipById(page, idB).boundingBox())!;
    const finalC = (await clipById(page, idC).boundingBox())!;
    expect(finalA.x).toBeCloseTo(aBoxOriginal.x, -1);
    expect(finalB.x).toBeCloseTo(bBoxAfterMove.x, -1);
    expect(finalC.x).toBeCloseTo(finalB.x + finalB.width, -1);
  });

  test("Escape also declines the swap", async ({ page }) => {
    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    const clips = page.locator(SELECTORS.draggableClip);
    const secondBoxBefore = (await clips.nth(1).boundingBox())!;

    await dragClipOnto(page, clips.nth(1), clips.nth(0));
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();

    const afterBox = (await clips.nth(1).boundingBox())!;
    expect(afterBox.x).toBeCloseTo(secondBoxBefore.x, -1);
  });

  test("cross-track overlap still blocks/clamps, never offers a swap", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("a.wav", 2)]);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    // Selects track 2 (EditorShell's manual click-detection, controls column).
    await page.getByText("Track 2", { exact: true }).click();
    await uploadFiles(page, [makeSineWavFile("b.wav", 2)]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(2);
    const track1Clip = clips.nth(0);
    const track2Clip = clips.nth(1);
    const track2Box = (await track2Clip.boundingBox())!;

    const box = (await track1Clip.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const targetY = track2Box.y + track2Box.height / 2;

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, startY + 15, { steps: 5 });
      await page.mouse.move(startX, targetY, { steps: 10 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(true);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();

    // Both clips now on track 2, adjacent and non-overlapping.
    await expect(clips).toHaveCount(2);
    const finalBoxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
    ].sort((a, b) => a.x - b.x);
    expect(finalBoxes[1].x).toBeCloseTo(finalBoxes[0].x + finalBoxes[0].width, -1);
  });

  test("cross-track drop that only overlaps the nearer clip still skips past a farther one too", async ({ page }) => {
    // Regression test: resolveNonOverlappingStart (shared with the upload
    // path) used to be reached via a single-neighbor constrainClipDrag
    // clamp that only examined whichever existing clip ended up adjacent to
    // the proposed position in a merged sorted list — it never checked
    // whether the dragged clip's own duration reached past that neighbor
    // into a second, farther one. Dropping mostly onto P here (a big clip)
    // while just grazing the far edge of Q (a small clip right after P)
    // used to land the dragged clip overlapping P instead of skipping past
    // both P and Q.
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("source.wav", 2)]);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    await page.getByText("Track 2", { exact: true }).click();
    await uploadFiles(page, [makeSineWavFile("p.wav", 3), makeSineWavFile("q.wav", 0.5)]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(3);
    const sourceClip = clips.nth(0);
    const pBox = (await clips.nth(1).boundingBox())!;
    const qBox = (await clips.nth(2).boundingBox())!;

    const sourceBox = (await sourceClip.boundingBox())!;
    const startX = sourceBox.x + sourceBox.width / 2;
    const startY = sourceBox.y + sourceBox.height / 2;
    // Target the dragged clip's center around the midpoint of P — its own
    // width means the resulting span reaches past P's end into Q.
    const targetX = pBox.x + pBox.width * 0.5 + sourceBox.width / 2;
    const targetY = pBox.y + pBox.height / 2;

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, startY + 15, { steps: 5 });
      await page.mouse.move(targetX, targetY, { steps: 15 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(true);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();

    await expect(clips).toHaveCount(3);
    const track2Boxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
      (await clips.nth(2).boundingBox())!,
    ]
      .filter((b) => Math.abs(b.y - pBox.y) < 5)
      .sort((a, b) => a.x - b.x);

    expect(track2Boxes).toHaveLength(3);
    expect(track2Boxes[0].x).toBeCloseTo(pBox.x, -1);
    expect(track2Boxes[1].x).toBeCloseTo(qBox.x, -1);
    // Dragged clip must land after Q, not overlapping P or Q.
    expect(track2Boxes[2].x).toBeCloseTo(track2Boxes[1].x + track2Boxes[1].width, -1);
  });

  test("a large jump onto a non-adjacent clip falls back to block/clamp, no swap", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [
      makeSineWavFile("a.wav", 2),
      makeSineWavFile("b.wav", 2),
      makeSineWavFile("c.wav", 2),
    ]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(3);
    const firstClip = clips.nth(0);
    const thirdBox = (await clips.nth(2).boundingBox())!;
    const targetX = thirdBox.x + thirdBox.width / 2;

    const rebuilt = await rebuildsEngine(page, async () => {
      const box = (await firstClip.boundingBox())!;
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 10, startY, { steps: 5 });
      await page.mouse.move(targetX, startY, { steps: 10 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(true);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();

    // Landed right after the far clip, not overlapping it.
    const finalBoxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
      (await clips.nth(2).boundingBox())!,
    ].sort((a, b) => a.x - b.x);
    expect(finalBoxes[2].x).toBeCloseTo(finalBoxes[1].x + finalBoxes[1].width, -1);
  });

  test("clicking anything outside the popover implicitly declines it", async ({ page }) => {
    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    const clips = page.locator(SELECTORS.draggableClip);
    const secondBoxBefore = (await clips.nth(1).boundingBox())!;

    await dragClipOnto(page, clips.nth(1), clips.nth(0));
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();

    // A click anywhere outside the popover's own DOM (not just its Cancel
    // button) counts as a decline — same pattern as ClipActionsMenu's own
    // outside-pointerdown dismissal.
    await page.getByRole("button", { name: "+ New Track" }).click();
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();
    await waitForWaveformReady(page);

    const afterBox = (await clips.nth(1).boundingBox())!;
    expect(afterBox.x).toBeCloseTo(secondBoxBefore.x, -1);
  });

  test("confirming a stale swap (clips undone away underneath it) safely no-ops", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await gotoEditor(page);
    await uploadTwoContiguousClips(page);

    const clips = page.locator(SELECTORS.draggableClip);
    await dragClipOnto(page, clips.nth(1), clips.nth(0));
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();

    // Ctrl+Z is a keydown, not a pointerdown, so it does NOT trigger the
    // popover's outside-click dismissal — it stays open while the clips it
    // refers to are undone away entirely (back to the default empty track).
    await page.keyboard.press("Control+z");
    await waitForWaveformReady(page);
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeVisible();
    await expect(clips).toHaveCount(0);

    // Confirming now must not crash or resurrect a malformed clip.
    await page.getByRole("button", SWAP).click();
    await expect(page.getByRole("dialog", SWAP_DIALOG)).toBeHidden();
    await expect(clips).toHaveCount(0);
    expect(pageErrors).toHaveLength(0);
  });
});
