import { test, expect } from "@playwright/test";
import * as fs from "fs";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor } from "./helpers";

const EXPORT = { name: /Export/ } as const;

/**
 * Reads this app's own fixed 44-byte-header 16-bit PCM WAV layout (matches
 * @waveform-playlist/browser/tone's encodeWav — see useProjectExport.ts).
 */
function readWav(buffer: Buffer) {
  const sampleRate = buffer.readUInt32LE(24);
  const numChannels = buffer.readUInt16LE(22);
  const dataSize = buffer.readUInt32LE(40);
  const numSamples = dataSize / 2 / numChannels;
  const duration = numSamples / sampleRate;
  return {
    sampleRate,
    numChannels,
    duration,
    sampleAt: (timeSeconds: number) => {
      const i = Math.round(timeSeconds * sampleRate) * numChannels;
      return buffer.readInt16LE(44 + i * 2) / 32768;
    },
    maxAbsInWindow: (startSeconds: number, windowSeconds: number) => {
      const startIndex = Math.round(startSeconds * sampleRate);
      const count = Math.round(windowSeconds * sampleRate);
      let max = 0;
      for (let i = startIndex; i < startIndex + count; i++) {
        const offset = 44 + i * numChannels * 2;
        if (offset + 2 > buffer.length) break;
        max = Math.max(max, Math.abs(buffer.readInt16LE(offset) / 32768));
      }
      return max;
    },
  };
}

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
