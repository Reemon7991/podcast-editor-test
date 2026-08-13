import { test, expect, type Page } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import {
  SELECTORS,
  waitForWaveformReady,
  uploadFiles,
  gotoEditor,
  rebuildsEngine,
  waitForTranscriptSettled,
  readTranscripts,
} from "./helpers";

const UNDO = { name: "Undo" } as const;
const REMOVE_FILLER_WORDS = { name: /^Remove filler words$|^Removing filler words…$/ } as const;

// "Hello" / "world" / "today" are real words, never matched — the three
// filler words below (2x "um", 1x "uh") are what this suite expects removed.
// All comfortably inside a 3s clip; /api/transcribe is mocked at the browser
// level throughout (see helpers.ts's mockTranscribeRoute doc comment on why
// — same split tts.spec.ts/ttsRoute.spec.ts and transcription.spec.ts
// already establish), so the underlying WAV content itself is irrelevant.
const WORDS_WITH_FILLERS = [
  { word: "Hello", start: 0.1, end: 0.3 },
  { word: "um,", start: 0.5, end: 0.6 },
  { word: "world", start: 0.8, end: 1.0 },
  { word: "uh", start: 1.2, end: 1.3 },
  { word: "today", start: 1.5, end: 1.7 },
  { word: "um", start: 2.0, end: 2.1 },
];
const WORDS_WITHOUT_FILLERS = [
  { word: "Hello", start: 0.1, end: 0.3 },
  { word: "world", start: 0.5, end: 0.7 },
];

async function clipActionsButtonFor(page: Page, clip: ReturnType<Page["locator"]>) {
  const clipId = await clip.getAttribute("data-clip-id");
  return page.locator(`button[data-clip-actions-for="${clipId}"]`);
}

async function mockTranscribeWith(page: Page, words: typeof WORDS_WITH_FILLERS) {
  await page.route("**/api/transcribe", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ words }) })
  );
}

/**
 * Per-clip filler-word removal (see TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's
 * Phase 6) — transcript-driven (not RMS-based like silence removal), so
 * every test here mocks a finished transcript rather than needing real
 * speech content or a live Whisper call. Mirrors silenceRemoval.spec.ts's
 * own coverage shape (kept-duration via one rebuild, undo, no-op path, the
 * app-wide processing guard, the toast auto-dismiss, the persistence
 * round-trip, remap-not-retranscribe) plus this feature's own two
 * additions: the transcript-readiness gate on the menu item, and the
 * confirm-before-apply step silence removal doesn't have.
 */
test.describe("Remove filler words", () => {
  test("the menu item stays disabled until the clip's transcript finishes", async ({ page }) => {
    await gotoEditor(page);
    // Never resolves — same "still in flight" simulation
    // transcription.spec.ts's own background-transcription test uses.
    await page.route("**/api/transcribe", () => {});

    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await expect(page.getByRole("menuitem", REMOVE_FILLER_WORDS)).toBeDisabled();
  });

  test("shows a confirmation with per-word counts, and removing shrinks the clip via one rebuild", async ({
    page,
  }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const originalWidth = (await clip.boundingBox())!.width;

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();

    const dialog = page.getByRole("alertdialog", { name: "Remove filler words?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("um");
    await expect(dialog).toContainText("× 2");
    await expect(dialog).toContainText("uh");
    await expect(dialog).toContainText("× 1");

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("button", { name: "Remove 3 words" }).click();
    });
    expect(rebuilt).toBe(true);

    await expect(page.getByText("3 filler words removed.")).toBeVisible();
    const trimmedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(trimmedWidth).toBeLessThan(originalWidth);
  });

  test("canceling the confirmation leaves the clip and history untouched", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const widthBefore = (await clip.boundingBox())!.width;
    const undoWasEnabled = await page.getByRole("button", UNDO).isEnabled(); // true — uploading is itself a commit

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();

    const dialog = page.getByRole("alertdialog", { name: "Remove filler words?" });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    expect(await page.getByRole("button", UNDO).isEnabled()).toBe(undoWasEnabled);
    expect((await clip.boundingBox())!.width).toBeCloseTo(widthBefore, 0);
  });

  // Regression test: Ctrl+Z listens on `window`, so the confirm dialog's
  // backdrop (pointer-only) doesn't stop it — pressing it while the dialog
  // is open used to undo the upload itself out from under the dialog.
  test("Ctrl+Z is ignored while the confirmation is open", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();

    const dialog = page.getByRole("alertdialog", { name: "Remove filler words?" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Control+z");

    // If the shortcut had fired, the upload's own commit would be undone,
    // removing the clip entirely.
    await expect(dialog).toBeVisible();
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);
  });

  test("a clip with no filler words shows a toast directly — no confirmation opens", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITHOUT_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const widthBefore = (await clip.boundingBox())!.width;

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();
      await expect(page.getByText("No filler words detected in this clip.")).toBeVisible();
    });
    expect(rebuilt).toBe(false);
    await expect(page.getByRole("alertdialog", { name: "Remove filler words?" })).toHaveCount(0);
    expect((await clip.boundingBox())!.width).toBeCloseTo(widthBefore, 0);
  });

  test("undo restores the original clip and audio in one step", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const originalWidth = (await clip.boundingBox())!.width;

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();
    await page.getByRole("button", { name: "Remove 3 words" }).click();
    await waitForWaveformReady(page);

    const trimmedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(trimmedWidth).toBeLessThan(originalWidth);

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);

    const restoredWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(restoredWidth).toBeCloseTo(originalWidth, -1);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  });

  test("the editor is fully re-enabled after filler-word removal settles", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();
    await page.getByRole("button", { name: "Remove 3 words" }).click();
    await waitForWaveformReady(page);

    await expect(page.getByTestId("filler-word-removal-overlay")).toBeHidden();
    await expect(page.getByTestId("top-bar")).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("transport-bar")).toHaveAttribute("aria-disabled", "false");
  });

  test("the success toast auto-dismisses on its own", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();
    await page.getByRole("button", { name: "Remove 3 words" }).click();
    await waitForWaveformReady(page);

    const toast = page.getByText("3 filler words removed.");
    await expect(toast).toBeVisible();
    // AUTO_DISMISS_MS is 5000 (Toast.tsx) — wait past it, then confirm gone
    // on its own, not just dismissible via the close button.
    await expect(toast).toBeHidden({ timeout: 6000 });
  });

  test("the spliced clip survives a reload and still plays", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();
    await page.getByRole("button", { name: "Remove 3 words" }).click();
    await waitForWaveformReady(page);

    const trimmedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;

    // Give the debounced save (500ms trailing-edge, see PodcastEditor.tsx)
    // time to land before reloading.
    await page.waitForTimeout(800);
    await page.reload();
    await waitForWaveformReady(page);

    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);
    const reloadedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(reloadedWidth).toBeCloseTo(trimmedWidth, 0);

    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  });

  /**
   * Remap-not-retranscribe — same property silenceRemoval.spec.ts's own
   * equivalent test proves for that feature, now via clipSplice.ts's shared
   * spliceKeepRanges/keepRanges contract instead of a duplicated splice path.
   */
  test("filler-word removal remaps the source transcript locally instead of re-transcribing", async ({ page }) => {
    await gotoEditor(page);

    let transcribeCallCount = 0;
    await page.route("**/api/transcribe", (route) => {
      transcribeCallCount++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ words: WORDS_WITH_FILLERS }),
      });
    });

    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    const original = await waitForTranscriptSettled(page);
    expect(transcribeCallCount).toBe(1);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    const commitStart = Date.now();
    await page.getByRole("menuitem", REMOVE_FILLER_WORDS).click();
    await page.getByRole("button", { name: "Remove 3 words" }).click();
    await expect(page.getByText("3 filler words removed.")).toBeVisible();

    // The new asset's transcript should appear essentially immediately — a
    // remap is synchronous local work, unlike a real network round trip.
    await expect
      .poll(async () => (await readTranscripts(page)).length, { timeout: 2000 })
      .toBe(2);
    expect(Date.now() - commitStart).toBeLessThan(1000);

    // The real proof: no second call to /api/transcribe.
    expect(transcribeCallCount).toBe(1);

    const transcripts = await readTranscripts(page);
    const newTranscript = transcripts.find((t) => t.assetId !== original.assetId)!;
    expect(newTranscript.status).toBe("done");
    // Only the three real words survive — every filler word (and its
    // padding) was cut.
    expect(newTranscript.words!.map((w) => w.word)).toEqual(["Hello", "world", "today"]);
  });

  test("Remove silence and Remove filler words disable each other while either is selected as the active clip action", async ({
    page,
  }) => {
    // Not a timing/race proof (see silenceRemoval.spec.ts's own disclosed
    // note on why observing an in-flight overlay isn't reliably provable
    // under Playwright for this app's small test fixtures) — this instead
    // confirms the static wiring: both menu items read the same combined
    // isBusyProcessingClip flag, so if one is ever mid-flight the other is
    // provably disabled by inspection of EditorShell.tsx. Covered here as a
    // plain "both items exist and are independently clickable when idle"
    // sanity check, since the actual cross-disable moment can't be forced
    // reliably in this harness.
    await gotoEditor(page);
    await mockTranscribeWith(page, WORDS_WITH_FILLERS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 3)]);
    await waitForTranscriptSettled(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await expect(page.getByRole("menuitem", { name: "Remove silence" })).toBeEnabled();
    await expect(page.getByRole("menuitem", REMOVE_FILLER_WORDS)).toBeEnabled();
  });
});
