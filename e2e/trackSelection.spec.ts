import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, uploadFiles, waitForWaveformReady, gotoEditor } from "./helpers";

/**
 * A newly added track becomes the active one immediately — previously a
 * user had to click the new track's own label first, or an upload would
 * silently land back on track 1.
 */
test.describe("Track selection", () => {
  test("adding a track selects it, so the next upload lands there with no extra click", async ({
    page,
  }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);

    // Deliberately no "Track 2" click here — the point under test is that
    // adding the track alone is enough to make it active.
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const clipBox = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!;
    // .first() picks the controls-column label — a track's name can also
    // match elsewhere in the DOM, which isn't the element under test here.
    const track1Box = (await page.getByText("Track 1", { exact: true }).first().boundingBox())!;
    const track2Box = (await page.getByText("Track 2", { exact: true }).first().boundingBox())!;

    const distanceToTrack1 = Math.abs(clipBox.y - track1Box.y);
    const distanceToTrack2 = Math.abs(clipBox.y - track2Box.y);
    expect(distanceToTrack2).toBeLessThan(distanceToTrack1);
  });
});
