import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, uploadFiles, gotoEditor } from "./helpers";

/**
 * useTimelineTracks.addFilesToTrack used to insert a batch at the playhead
 * with no collision check — uploading twice at the same position silently
 * stacked clips. Fixed via clipGeometry.ts's resolveNonOverlappingStart (see
 * CLAUDE.md's "Uploading onto an occupied playhead position" section).
 */
test.describe("Upload collision avoidance", () => {
  test("uploading a second clip at the same playhead position lands after the first, not on top of it", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("a.wav", 2)]);

    const clips = page.locator(SELECTORS.draggableClip);
    const firstBox = (await clips.nth(0).boundingBox())!;

    // Playhead is still at 0 — uploading again targets the same position
    // the first clip already occupies.
    await uploadFiles(page, [makeSineWavFile("b.wav", 3)]);

    await expect(clips).toHaveCount(2);
    const [box0, box1] = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
    ].sort((a, b) => a.x - b.x);

    expect(box0.x).toBeCloseTo(firstBox.x, -1);
    expect(box0.width).toBeCloseTo(firstBox.width, -1);
    // Second clip pushed forward, right after the first — not overlapping.
    expect(box1.x).toBeCloseTo(box0.x + box0.width, -1);
  });

  test("uploading a batch of files at the same occupied position keeps them contiguous with each other", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("a.wav", 2)]);

    const clips = page.locator(SELECTORS.draggableClip);
    const firstBox = (await clips.nth(0).boundingBox())!;

    await uploadFiles(page, [makeSineWavFile("b.wav", 1), makeSineWavFile("c.wav", 1)]);

    await expect(clips).toHaveCount(3);
    const boxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
      (await clips.nth(2).boundingBox())!,
    ].sort((a, b) => a.x - b.x);

    expect(boxes[0].x).toBeCloseTo(firstBox.x, -1);
    // b.wav and c.wav land back-to-back with each other, right after a.wav.
    expect(boxes[1].x).toBeCloseTo(boxes[0].x + boxes[0].width, -1);
    expect(boxes[2].x).toBeCloseTo(boxes[1].x + boxes[1].width, -1);
  });

  test("a third upload that only overlaps the first clip's original span still skips past the second clip too", async ({ page }) => {
    // Regression test: resolveNonOverlappingStart used to check the new
    // clip's span against the ORIGINAL proposed position only, then push
    // forward once past whatever it found there — without re-checking
    // whether the pushed-forward position lands on something else. A short
    // clip re-uploaded here doesn't overlap clip B's span when checked at
    // its original (pre-push) position, so the old code pushed it only past
    // A and stopped, landing it exactly on top of B.
    await gotoEditor(page);
    const shortClip = makeSineWavFile("short.wav", 1);
    await uploadFiles(page, [shortClip]);

    const clips = page.locator(SELECTORS.draggableClip);
    const firstBox = (await clips.nth(0).boundingBox())!;

    await uploadFiles(page, [makeSineWavFile("long.wav", 5)]);
    await expect(clips).toHaveCount(2);
    const secondBox = (await clips.nth(1).boundingBox())!;

    // Same file again, playhead still untouched.
    await uploadFiles(page, [shortClip]);
    await expect(clips).toHaveCount(3);

    const boxes = [
      (await clips.nth(0).boundingBox())!,
      (await clips.nth(1).boundingBox())!,
      (await clips.nth(2).boundingBox())!,
    ].sort((a, b) => a.x - b.x);

    expect(boxes[0].x).toBeCloseTo(firstBox.x, -1);
    expect(boxes[1].x).toBeCloseTo(secondBox.x, -1);
    // Third clip must land after the SECOND clip, not on top of it.
    expect(boxes[2].x).toBeCloseTo(boxes[1].x + boxes[1].width, -1);
  });
});
