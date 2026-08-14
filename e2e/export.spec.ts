import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor, readWav } from "./helpers";

const EXPORT = { name: /Export/ } as const;
const WAV_MENU_ITEM = { name: "WAV (lossless)" } as const;
const MP3_128_MENU_ITEM = { name: "MP3 · 128 kbps" } as const;
const AAC_128_MENU_ITEM = { name: "AAC · 128 kbps" } as const;

/** Opens the Export dropdown and clicks the given format's menu item — same
 *  "trigger button -> role=menuitem" shape tts.spec.ts's ADD_CLIP_BUTTON /
 *  "+ Clip" pattern already established, factored out here since every test
 *  in this file needs it (unlike tts.spec.ts, where inlining it once per
 *  test was still the smaller diff). */
async function exportAs(page: Page, menuItem: { name: string }) {
  await page.getByRole("button", EXPORT).click();
  await page.getByRole("menuitem", menuItem).click();
}

test.describe("Export", () => {
  test("Export menu lists WAV and every compressed format", async ({ page }) => {
    await gotoEditor(page);
    await page.getByRole("button", EXPORT).click();
    await expect(page.getByRole("menuitem", { name: "WAV (lossless)" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "MP3 · 64 kbps" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "MP3 · 128 kbps" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "MP3 · 160 kbps" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "AAC · 128 kbps" })).toBeVisible();
  });

  test("MP3 export works via the WASM polyfill even without native browser support", async ({
    page,
  }) => {
    // Regression test for the actual feature in utils/exportFormats.ts's
    // ensureMp3EncoderReady, not just "some compressed format works" (the
    // other compressed-format test below is deliberately format-agnostic,
    // so it would keep passing silently if this polyfill mechanism broke —
    // it'd just quietly fall back to testing AAC instead). Confirmed live:
    // this project's own Playwright Chromium build has no *native* MP3
    // encoder, so this item being enabled at all is proof the
    // @mediabunny/mp3-encoder polyfill actually registered and works, not a
    // trivially-true assertion.
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    await page.getByRole("button", EXPORT).click();
    await expect(page.getByRole("menuitem", MP3_128_MENU_ITEM)).toBeEnabled();

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", MP3_128_MENU_ITEM).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(
      /^podcast-export-\d{8}-\d{6}-mp3-128kbps\.mp3$/
    );
    const size = fs.statSync((await download.path())!).size;
    // 128kbps * 3s / 8 bits-per-byte ≈ 48KB — a wide tolerance band, not
    // pinning an exact byte count the encoder's internals could shift.
    expect(size).toBeGreaterThan(20_000);
    expect(size).toBeLessThan(80_000);
  });

  test("Export button downloads a WAV matching the timeline duration", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    const downloadPromise = page.waitForEvent("download");
    await exportAs(page, WAV_MENU_ITEM);
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
    await exportAs(page, WAV_MENU_ITEM);
    await expect(page.getByTestId("transport-bar")).toHaveAttribute("aria-disabled", "true");

    await downloadPromise;
    await expect(page.getByTestId("transport-bar")).toHaveAttribute("aria-disabled", "false");
  });

  test("muting the only track shows an error instead of downloading silence", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    await page.getByRole("button", { name: "Mute" }).first().click();
    await exportAs(page, WAV_MENU_ITEM);

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

    await exportAs(page, WAV_MENU_ITEM);
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
    await exportAs(page, WAV_MENU_ITEM);
    const download = await downloadPromise;
    const wav = readWav(fs.readFileSync((await download.path())!));

    // Near the very start (mid-fade), amplitude should be much lower than
    // well into the clip (past the fade, full volume sine wave peaks ~0.5).
    expect(wav.maxAbsInWindow(0, 0.02)).toBeLessThan(0.15);
    expect(wav.maxAbsInWindow(2, 0.02)).toBeGreaterThan(0.3);
  });

  test("a compressed export downloads a correctly-named file smaller than the WAV equivalent", async ({
    page,
  }) => {
    // MP3/AAC encode support depends on this browser's WebCodecs
    // AudioEncoder — unlike WAV, which never needs one (see
    // utils/exportFormats.ts's own doc comment). Confirmed live: this
    // project's own Playwright Chromium build supports AAC but not MP3, so
    // this picks whichever menu item is actually enabled rather than
    // hard-coding one — same "don't assert something this environment can't
    // prove" discipline CLAUDE.md's Verification section already documents
    // for the two playback-guard races.
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    await page.getByRole("button", EXPORT).click();
    const mp3Enabled = await page.getByRole("menuitem", MP3_128_MENU_ITEM).isEnabled();
    const aacEnabled = await page.getByRole("menuitem", AAC_128_MENU_ITEM).isEnabled();
    await page.keyboard.press("Escape");
    test.skip(!mp3Enabled && !aacEnabled, "Neither MP3 nor AAC encoding is supported in this browser");

    const menuItem = mp3Enabled ? MP3_128_MENU_ITEM : AAC_128_MENU_ITEM;
    const filenamePattern = mp3Enabled
      ? /^podcast-export-\d{8}-\d{6}-mp3-128kbps\.mp3$/
      : /^podcast-export-\d{8}-\d{6}-aac-128kbps\.m4a$/;

    const compressedPromise = page.waitForEvent("download");
    await exportAs(page, menuItem);
    const compressedDownload = await compressedPromise;
    expect(compressedDownload.suggestedFilename()).toMatch(filenamePattern);
    const compressedSize = fs.statSync((await compressedDownload.path())!).size;

    const wavPromise = page.waitForEvent("download");
    await exportAs(page, WAV_MENU_ITEM);
    const wavDownload = await wavPromise;
    const wavSize = fs.statSync((await wavDownload.path())!).size;

    // Uncompressed PCM vs. 128kbps MP3/AAC for the same 3s tone —
    // comfortably more than 2x smaller, without pinning an exact ratio
    // either encoder's internals could shift slightly.
    expect(compressedSize).toBeLessThan(wavSize / 2);
  });
});
