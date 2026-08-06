import { test, expect } from "@playwright/test";
import * as fs from "fs";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor, readWav } from "./helpers";

const EXPORT = { name: /Export/ } as const;

test.describe("Export", () => {
  test("Export button downloads a WAV matching the timeline duration", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", EXPORT).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^podcast-export-\d{8}-\d{6}\.wav$/);
    const path = await download.path();
    const wav = readWav(fs.readFileSync(path!));
    expect(wav.duration).toBeGreaterThan(3);
    expect(wav.duration).toBeLessThan(3.5); // clip + the library's own ~100ms tail pad
  });

  test("Export disables the transport bar while rendering", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", EXPORT).click();
    await expect(page.getByTestId("transport-bar")).toHaveAttribute("aria-disabled", "true");

    await downloadPromise;
    await expect(page.getByTestId("transport-bar")).toHaveAttribute("aria-disabled", "false");
  });

  test("muting the only track shows an error instead of downloading silence", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    await page.getByRole("button", { name: "Mute" }).first().click();
    await page.getByRole("button", EXPORT).click();

    await expect(page.getByText("No tracks to export")).toBeVisible();
  });

  test("soloing an already-muted track still exports nothing (matches live playback)", async ({
    page,
  }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    await page.getByText("+ New Track").click();
    await waitForWaveformReady(page);
    await page.getByText("Track 2", { exact: true }).click();
    await uploadFiles(page, [makeSineWavFile("tone2.wav", 3)]);

    // Track 1: soloed AND muted. Live playback semantics (TonePlayout):
    // soloing doesn't override a track's own mute, so this is silent too —
    // and since it's the only soloed track, Track 2 gets muted-by-exclusion.
    // Net result: nothing is audible. useExportWav's own filter gets this
    // combination wrong (would treat Track 1 as audible) — this is the
    // regression test for computeAudibleTracks fixing that.
    await page.getByRole("button", { name: "Mute" }).first().click();
    await page.getByRole("button", { name: "Solo" }).first().click();

    await page.getByRole("button", EXPORT).click();
    await expect(page.getByText("No tracks to export")).toBeVisible();
  });

  test("a fade-in ramps up in the exported audio", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    const box = (await page.locator(SELECTORS.fadeInHandle).first().boundingBox())!;
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 60, start.y, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", EXPORT).click();
    const download = await downloadPromise;
    const wav = readWav(fs.readFileSync((await download.path())!));

    // Near the very start (mid-fade), amplitude should be much lower than
    // well into the clip (past the fade, full volume sine wave peaks ~0.5).
    expect(wav.maxAbsInWindow(0, 0.02)).toBeLessThan(0.15);
    expect(wav.maxAbsInWindow(2, 0.02)).toBeGreaterThan(0.3);
  });
});
