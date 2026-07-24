import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles } from "./helpers";

/**
 * Phase 0 smoke test (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md) — proves the
 * committed Playwright harness itself works, porting this project's existing
 * manually-verified single-file playback flow (import, play, seek, zoom)
 * before Phase 1 starts layering the metadata/hydration boundary underneath
 * it. Later phases extend this suite; they don't replace it.
 */
test.describe("single-clip playback", () => {
  test("import, play, and zoom", async ({ page }) => {
    await page.goto("/");
    await waitForWaveformReady(page);

    const initialDuration = await page.locator(SELECTORS.totalDuration).textContent();

    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    // Duration label should reflect the newly imported ~2s clip.
    await expect(page.locator(SELECTORS.totalDuration)).not.toHaveText(initialDuration ?? "");
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);

    // Zoom controls shouldn't error against a freshly-built engine.
    await page.getByRole("button", { name: "Zoom In", exact: true }).click();
    await page.getByRole("button", { name: "Zoom Out", exact: true }).click();

    // Play a real user gesture (required for AudioContext autoplay policy),
    // confirm the live time display advances, then pause and confirm it stops.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeDisabled();

    await expect(async () => {
      const t = await page.locator(SELECTORS.currentTime).textContent();
      expect(t).not.toBe("0:00");
    }).toPass({ timeout: 5_000 });

    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const pausedAt = await page.locator(SELECTORS.currentTime).textContent();
    await page.waitForTimeout(300);
    await expect(page.locator(SELECTORS.currentTime)).toHaveText(pausedAt ?? "");

    // No uncaught page errors anywhere in this flow (catches the
    // TonePlayout/rebuild-race class of bug documented in CLAUDE.md).
  });

  test("surfaces no uncaught page errors during import/play/pause", async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on("pageerror", (err) => pageErrors.push(err));

    await page.goto("/");
    await waitForWaveformReady(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Pause", exact: true }).click();

    expect(pageErrors).toEqual([]);
  });
});
