import { test, expect, type Page } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor, rebuildsEngine } from "./helpers";

// ClipActionsOverlay.tsx renders one persistent "..." button per clip (not
// just for a hovered one), so a plain getByRole("button", { name: "Clip
// actions" }) is ambiguous once more than one clip exists. The button
// carries `data-clip-actions-for` (ClipActionsMenu.tsx's own `clipId` prop,
// deliberately not `data-clip-id` — see that file's doc comment), so reading
// a clip's id off its own `data-clip-id` and scoping the button query by it
// picks out the right one.
async function clipActionsButtonFor(page: Page, clip: ReturnType<Page["locator"]>) {
  const clipId = await clip.getAttribute("data-clip-id");
  return page.locator(`button[data-clip-actions-for="${clipId}"]`);
}

/**
 * useClipActions.duplicateClip used to place the copy at
 * clip.startSample + clip.durationSamples with no collision check — if
 * another clip already sat right after the source, the duplicate landed
 * squarely on top of it. Fixed via clipGeometry.ts's
 * resolveNonOverlappingStart, the same collision-avoidance function uploads
 * and drag/drop already use.
 */
test.describe("Duplicate collision avoidance", () => {
  test("duplicating a clip with a neighbor right after it lands past that neighbor, not on top of it", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [
      makeSineWavFile("a.wav", 2),
      makeSineWavFile("b.wav", 3),
    ]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(2);
    const aBox = (await clips.nth(0).boundingBox())!;
    const bBox = (await clips.nth(1).boundingBox())!;

    await clips.nth(0).hover();
    await (await clipActionsButtonFor(page, clips.nth(0))).click();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
    });
    expect(rebuilt).toBe(true);

    await expect(clips).toHaveCount(3);
    const boxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
      (await clips.nth(2).boundingBox())!,
    ].sort((x, y) => x.x - y.x);

    // Original a and b untouched; the duplicate landed after b, not on it.
    expect(boxes[0].x).toBeCloseTo(aBox.x, -1);
    expect(boxes[1].x).toBeCloseTo(bBox.x, -1);
    expect(boxes[2].x).toBeCloseTo(boxes[1].x + boxes[1].width, -1);
  });

  test("duplicating a clip with no neighbor right after it still lands immediately after the source", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("a.wav", 2)]);

    const clips = page.locator(SELECTORS.draggableClip);
    const aBox = (await clips.nth(0).boundingBox())!;

    await clips.nth(0).hover();
    await page.getByRole("button", { name: "Clip actions" }).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await waitForWaveformReady(page);

    await expect(clips).toHaveCount(2);
    const boxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
    ].sort((x, y) => x.x - y.x);
    expect(boxes[0].x).toBeCloseTo(aBox.x, -1);
    expect(boxes[1].x).toBeCloseTo(boxes[0].x + boxes[0].width, -1);
  });
});
