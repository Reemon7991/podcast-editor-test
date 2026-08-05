import { test, expect } from "@playwright/test";
import { makeSineWavBuffer } from "./fixtures";
import { SELECTORS, waitForWaveformReady, gotoEditor } from "./helpers";

const GENERATE = { name: "Generate", exact: true } as const;
const GENERATE_MODAL = { name: "Generate clip (AI)" } as const;
const TEXT_PLACEHOLDER = "Type the words you want spoken…";
// TopBar.tsx's "+ Clip" trigger — its accessible name is "Clip", not
// "+ Clip": the "+" moved from the label text to a leading plus icon once
// one was added (MenuButton's `label` prop is `" Clip"`, which trims to
// "Clip" for accessible-name purposes), matching "+ New Track"'s use of a
// literal "+" only where there's no icon to carry that meaning instead.
const ADD_CLIP_BUTTON = { name: "Clip" } as const;

/**
 * "Generate clip (AI)" — see TTS_CARTESIA_PLAN.md. No real Cartesia call in
 * any of these: every test mocks `**\/api/tts` via page.route, reusing
 * fixtures.ts's makeSineWavBuffer for the mocked success response body (a
 * real WAV — decodable the same way an uploaded file already is, since the
 * client-side insertion path is identical either way).
 */
test.describe("Generate clip (AI)", () => {
  test("the + Clip dropdown opens and Generate clip (AI) opens the modal", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.getByRole("button", ADD_CLIP_BUTTON).click();
    await expect(page.getByRole("menuitem", { name: "Upload clip file" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Generate clip (AI)" })).toBeVisible();

    await page.getByRole("menuitem", { name: "Generate clip (AI)" }).click();
    await expect(page.getByRole("dialog", GENERATE_MODAL)).toBeVisible();
  });

  test("a successful generate inserts a clip at the playhead and closes the modal", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.route("**/api/tts", (route) =>
      route.fulfill({ status: 200, contentType: "audio/wav", body: makeSineWavBuffer(2) })
    );

    await page.getByRole("button", ADD_CLIP_BUTTON).click();
    await page.getByRole("menuitem", { name: "Generate clip (AI)" }).click();
    await page.getByPlaceholder(TEXT_PLACEHOLDER).fill("Hello from the test suite");
    await page.getByRole("button", GENERATE).click();

    await waitForWaveformReady(page);
    await expect(page.getByRole("dialog", GENERATE_MODAL)).toHaveCount(0);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);
  });

  test("an error response shows inline and inserts nothing", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.route("**/api/tts", (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Speech generation failed — the TTS service returned an error." }),
      })
    );

    await page.getByRole("button", ADD_CLIP_BUTTON).click();
    await page.getByRole("menuitem", { name: "Generate clip (AI)" }).click();
    await page.getByPlaceholder(TEXT_PLACEHOLDER).fill("Hello from the test suite");
    await page.getByRole("button", GENERATE).click();

    await expect(page.getByText("Speech generation failed")).toBeVisible();
    // Modal stays open so the user can retry without retyping.
    await expect(page.getByRole("dialog", GENERATE_MODAL)).toBeVisible();
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(0);
  });

  test("undo removes a generated clip in one step", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);

    await page.route("**/api/tts", (route) =>
      route.fulfill({ status: 200, contentType: "audio/wav", body: makeSineWavBuffer(2) })
    );

    await page.getByRole("button", ADD_CLIP_BUTTON).click();
    await page.getByRole("menuitem", { name: "Generate clip (AI)" }).click();
    await page.getByPlaceholder(TEXT_PLACEHOLDER).fill("Hello from the test suite");
    await page.getByRole("button", GENERATE).click();
    await waitForWaveformReady(page);

    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);

    await page.getByRole("button", { name: "Undo" }).click();
    await waitForWaveformReady(page);

    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(0);
  });
});
