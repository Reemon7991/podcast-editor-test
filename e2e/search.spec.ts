import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, uploadFiles, gotoEditor, mockTranscribeRoute } from "./helpers";
import { MAX_SEARCH_RESULTS } from "../src/utils/transcriptSearch";

const SEARCH_BUTTON = { name: "Search in the podcast" } as const;
const SEARCH_DIALOG = { name: "Search in the podcast" } as const;
const SEARCH_PLACEHOLDER = "Search words or phrases…";
const DUPLICATE = { name: "Duplicate" } as const;

const MOCK_WORDS = [
  { word: "The", start: 0.1, end: 0.3 },
  { word: "quick", start: 0.4, end: 0.7 },
  { word: "brown", start: 0.8, end: 1.1 },
  { word: "Fox", start: 1.2, end: 1.5 },
  { word: "jumps", start: 1.6, end: 1.9 },
];

// Packed tightly (0.03s apart) so all MAX_SEARCH_RESULTS + 15 instances fit
// inside the short synthetic clip's own duration — wordsInWindow filters out
// anything past the clip's actual audio, so these can't be spread out the
// way a real recording's repeated word would be.
const MANY_MATCHES = Array.from({ length: MAX_SEARCH_RESULTS + 15 }, (_, i) => ({
  word: "the",
  start: i * 0.03,
  end: i * 0.03 + 0.02,
}));

/**
 * Search — see TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 5.
 * `/api/transcribe` is mocked at the browser level (see helpers.ts's
 * mockTranscribeRoute); the underlying WAV content is irrelevant, only the
 * mocked word list matters for what's under test here.
 */
test.describe("Search in the podcast", () => {
  test("the search icon opens a popover titled 'Search in the podcast' with an input", async ({ page }) => {
    await gotoEditor(page);

    await page.getByRole("button", SEARCH_BUTTON).click();

    await expect(page.getByRole("dialog", SEARCH_DIALOG)).toBeVisible();
    await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).toBeVisible();
  });

  test("typing fewer than 3 characters does not search — no results, no message", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill("fo");

    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(0);
    await expect(page.getByText("Type a word or phrase to search.")).toBeVisible();
    await expect(page.getByText(/No matches for/)).toBeHidden();
  });

  test("typing 3 or more characters searches instantly, with no Enter press needed", async ({
    page,
  }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("fox");

    const result = page.locator('[role="dialog"] ul li button').first();
    await expect(result).toBeVisible();
    await expect(result.locator("mark")).toHaveText("Fox");
    await expect(result).toContainText("tone"); // clip name, from the uploaded filename
    const timestampText = await result.locator("span.font-mono").innerText();
    expect(timestampText).not.toContain(".");
    expect(timestampText).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test("clicking a result selects the clip and seeks the playhead to just before the match", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await expect(page.getByRole("button", DUPLICATE)).toBeDisabled();

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("fox");
    await page.locator('[role="dialog"] ul li button').first().click();

    // Selection: the clip toolbar (gated on a selected clip) enables.
    await expect(page.getByRole("button", DUPLICATE)).toBeEnabled();

    // Seek: "Fox" starts at 1.2s, lead-in is a fixed 0.5s (see
    // utils/transcriptSearch.ts's SEEK_LEAD_IN_SECONDS) -> ~0.7s.
    const currentTimeText = await page.locator(SELECTORS.currentTime).innerText();
    const [h, m, s] = currentTimeText.split(":").map(Number);
    const currentTimeSeconds = h * 3600 + m * 60 + s;
    expect(currentTimeSeconds).toBeCloseTo(0.7, 1);
  });

  test("a query with no matches shows a clear 'no matches' message, not an empty blank", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("zzz_no_such_word");

    await expect(page.getByText(/No matches for/)).toBeVisible();
    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(0);
  });

  test("closing and reopening the popover preserves the query and results", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("fox");
    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", SEARCH_DIALOG)).toBeHidden();

    await page.getByRole("button", SEARCH_BUTTON).click();
    await expect(page.getByRole("dialog", SEARCH_DIALOG)).toBeVisible();
    await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).toHaveValue("fox");
    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(1);
  });

  test("search stays a plain 'Searching…' state while a clip's transcript is still in flight — never mentions transcription", async ({
    page,
  }) => {
    await gotoEditor(page);
    // Submit resolves immediately (status flips to "transcribing" right
    // away) — the poll call is what hangs, matching the "still in flight"
    // window this test actually needs to observe.
    await page.route("**/api/transcribe", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ transcriptId: "job-1" }) })
    );
    let resolveTranscribe!: () => void;
    await page.route(
      "**/api/transcribe/*",
      (route) =>
        new Promise<void>((resolve) => {
          resolveTranscribe = () => {
            route
              .fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ status: "done", words: MOCK_WORDS }),
              })
              .then(resolve);
          };
        })
    );
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("fox");

    const dialog = page.getByRole("dialog", SEARCH_DIALOG);
    await expect(dialog.getByText("Searching…")).toBeVisible();
    await expect(dialog.getByText(/transcri/i)).toHaveCount(0); // never surfaces "transcription"/"transcribing"

    resolveTranscribe();
    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(1);
    await expect(page.getByText("Searching…")).toHaveCount(0);
  });

  test("a query matching more than MAX_SEARCH_RESULTS times is capped, with a disclosed 'showing top N of total' notice", async ({
    page,
  }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MANY_MATCHES);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("the");

    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(MAX_SEARCH_RESULTS);
    await expect(
      page.getByText(`Showing top ${MAX_SEARCH_RESULTS} of ${MANY_MATCHES.length} matches — refine your search.`)
    ).toBeVisible();
  });

  test("a query below MAX_SEARCH_RESULTS shows no truncation notice", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    await page.getByRole("button", SEARCH_BUTTON).click();
    const input = page.getByPlaceholder(SEARCH_PLACEHOLDER);
    await input.fill("fox");

    await expect(page.locator('[role="dialog"] ul li')).toHaveCount(1);
    await expect(page.getByText(/Showing top/)).toHaveCount(0);
  });
});
