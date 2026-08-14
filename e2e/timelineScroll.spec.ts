import { test, expect } from "@playwright/test";
import { computeCenteredScrollLeft } from "../src/utils/timelineScroll";

/**
 * Pure pixel-math coverage for utils/timelineScroll.ts — see its own doc
 * comment for why this exists (the library's own auto-scroll never runs
 * from a plain seekTo() while paused, exactly the "select a search result"
 * case). Same "plain in-process Node test" shape as transcriptionLogic.spec.ts.
 */
test.describe("computeCenteredScrollLeft (timelineScroll.ts)", () => {
  test("centers the target time in the viewport", () => {
    // 10s in, sampleRate=44100, samplesPerPixel=1024 -> pixelPosition ≈ 430.66px.
    // A 800px-wide viewport centers that at pixelPosition - 400.
    const result = computeCenteredScrollLeft(10, 44100, 1024, 800);
    expect(result).toBe(Math.round((10 * 44100) / 1024 - 400));
  });

  test("clamps to 0 rather than a negative scrollLeft near the start of the timeline", () => {
    const result = computeCenteredScrollLeft(0.1, 44100, 1024, 800);
    expect(result).toBe(0);
  });

  test("time 0 with any viewport width clamps to 0", () => {
    expect(computeCenteredScrollLeft(0, 44100, 1024, 1200)).toBe(0);
  });

  test("a narrower samplesPerPixel (more zoomed in) yields a larger pixel position for the same time", () => {
    const zoomedOut = computeCenteredScrollLeft(60, 44100, 2048, 800);
    const zoomedIn = computeCenteredScrollLeft(60, 44100, 512, 800);
    expect(zoomedIn).toBeGreaterThan(zoomedOut);
  });

  test("a wider viewport needs less scroll to center the same target time", () => {
    const narrow = computeCenteredScrollLeft(60, 44100, 1024, 400);
    const wide = computeCenteredScrollLeft(60, 44100, 1024, 1600);
    expect(wide).toBeLessThan(narrow);
  });
});
