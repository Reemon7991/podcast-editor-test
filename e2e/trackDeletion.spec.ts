import { test, expect } from "@playwright/test";
import { waitForWaveformReady, gotoEditor } from "./helpers";

const REMOVE_TRACK = { name: "Remove track" } as const;
const MUTE = { name: "Mute", exact: true } as const;

/**
 * A podcast needs at least one track — WaveformPlaylistProvider's
 * onRemoveTrack prop is all-or-nothing (it renders a close button on every
 * track or none), so PodcastEditor.tsx passes it as `undefined` whenever
 * only one track remains, hiding the button entirely rather than disabling
 * it per-track. See PodcastEditor.tsx's handleRemoveTrackByIndex doc
 * comment.
 */
test.describe("Track deletion guard", () => {
  test("the sole track's close button is hidden", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await expect(page.getByRole("button", MUTE)).toHaveCount(1);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(0);
  });

  test("close buttons appear once a second track exists, and removing one leaves the button hidden again", async ({
    page,
  }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(2);

    await page.getByRole("button", REMOVE_TRACK).first().click();
    await waitForWaveformReady(page);

    await expect(page.getByRole("button", MUTE)).toHaveCount(1);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(0);
  });
});
