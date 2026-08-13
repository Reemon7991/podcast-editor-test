import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import { makeSineWavFile, makeSegmentedWavFile, makeStereoSegmentedWavFile, type WavSegment } from "./fixtures";
import {
  SELECTORS,
  waitForWaveformReady,
  uploadFiles,
  gotoEditor,
  rebuildsEngine,
  readWav,
  waitForTranscriptSettled,
  readTranscripts,
} from "./helpers";

const UNDO = { name: "Undo" } as const;
const REMOVE_SILENCE = { name: /^Remove silence$|^Removing silence…$/ } as const;

// tone/silence/tone/silence/tone, sample-aligned to the 20ms default analysis
// window so kept-range boundaries land exactly where hand-computed below,
// not off by a partial window. Gaps (1.5s) are comfortably over the 0.4s
// minSilenceSeconds default; tones (1s) are comfortably over
// minKeptSegmentSeconds.
const SEGMENTS: WavSegment[] = [
  { kind: "tone", seconds: 1 },
  { kind: "silence", seconds: 1.5 },
  { kind: "tone", seconds: 1 },
  { kind: "silence", seconds: 1.5 },
  { kind: "tone", seconds: 1 },
];
// 3 tone segments (1s each) kept in full, plus 0.1s padding pulled in from
// each side of both interior silence gaps (2 gaps * 2 sides * 0.1s) — see
// SILENCE_REMOVAL_PLAN.md's algorithm section for the padding rule.
const EXPECTED_KEPT_SECONDS = 3 * 1 + 2 * 2 * 0.1;

async function clipActionsButtonFor(page: Page, clip: ReturnType<Page["locator"]>) {
  const clipId = await clip.getAttribute("data-clip-id");
  return page.locator(`button[data-clip-actions-for="${clipId}"]`);
}

/**
 * Per-clip silence removal (see SILENCE_REMOVAL_PLAN.md) — energy/RMS-based,
 * fully client-side, splices the kept audio into one continuous clip that
 * replaces the original in place (same startSample, no ripple to the rest
 * of the timeline). Covers the plan's own verification checklist: kept
 * duration, single-rebuild commit discipline, undo in one step, the
 * silence-free no-op path, the app-wide processing guard, and the
 * persistence round-trip.
 */
test.describe("Remove silence", () => {
  test("shrinks the clip to the expected kept-audio duration via exactly one engine rebuild", async ({
    page,
  }) => {
    await gotoEditor(page);
    // Upload a plain reference clip of the expected post-trim duration
    // alongside — comparing pixel widths against it avoids hardcoding this
    // app's own samplesPerPixel/zoom math in the test.
    await uploadFiles(page, [
      makeSegmentedWavFile("gaps.wav", SEGMENTS),
      makeSineWavFile("reference.wav", EXPECTED_KEPT_SECONDS),
    ]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(2);
    const referenceWidth = (await clips.nth(1).boundingBox())!.width;

    await clips.nth(0).hover();
    await (await clipActionsButtonFor(page, clips.nth(0))).click();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("menuitem", REMOVE_SILENCE).click();
    });
    expect(rebuilt).toBe(true);

    // Remove-silence replaces the clip with a fresh id (a new spliced
    // asset) — re-locate by position, not the pre-edit id.
    const trimmedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(trimmedWidth).toBeCloseTo(referenceWidth, -1);

    await expect(page.getByText("Silence removed.")).toBeVisible();
  });

  test("undo restores the original clip and audio in one step", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSegmentedWavFile("gaps.wav", SEGMENTS)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const originalWidth = (await clip.boundingBox())!.width;

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_SILENCE).click();
    await waitForWaveformReady(page);

    const trimmedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(trimmedWidth).toBeLessThan(originalWidth * 0.8);

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);

    const restoredWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(restoredWidth).toBeCloseTo(originalWidth, -1);

    // Restored audio is immediately playable — same signal
    // persistence.spec.ts's reload test uses (PlayPauseButton's accessible
    // name flips once play() actually resolves).
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  });

  test("a clip with no silence is a no-op — no rebuild, no new history entry", async ({ page }) => {
    await gotoEditor(page);
    // A plain, unmodulated tone (per SILENCE_REMOVAL_PLAN.md's own review —
    // no real quiet/loud contrast) is exactly the case
    // ABSOLUTE_QUIET_FLOOR/median-vs-threshold guard in
    // silenceDetection.ts exists for: bail out to "unchanged" rather than
    // misclassifying real content as removable silence.
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const widthBefore = (await clip.boundingBox())!.width;
    const undoWasEnabled = await page.getByRole("button", UNDO).isEnabled(); // true — uploading is itself a commit

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("menuitem", REMOVE_SILENCE).click();
      await expect(page.getByText("No silence detected in this clip.")).toBeVisible();
    });
    expect(rebuilt).toBe(false);

    // canUndo unchanged — the no-op path never calls commit(), so the
    // upload's own history entry is still the only one.
    expect(await page.getByRole("button", UNDO).isEnabled()).toBe(undoWasEnabled);
    expect((await clip.boundingBox())!.width).toBeCloseTo(widthBefore, 0);
  });

  // Not committed: directly observing the "editor disabled while processing"
  // overlay/aria-disabled mid-flight. Tried (page.getByTestId(
  // "silence-removal-overlay")).toBeVisible() immediately after the click,
  // mirroring export.spec.ts's own reliable "disables the transport bar
  // while rendering" test for isExporting — reproducibly failed 5/5 runs,
  // not flaky. Root cause traced earlier in this feature's history (see
  // useRemoveSilence.ts): export's own equivalent overlay stays up for a
  // genuinely slow OfflineAudioContext.render(); removeSilence's dominant
  // cost (crypto.subtle.digest + the IndexedDB write) is fast enough for a
  // small test clip, and unlike CPU-bound work isn't slowed by CPU
  // throttling, that the whole operation can complete before Playwright's
  // first poll ever observes the intermediate state. Same class of "not
  // solved by an automated test" race CLAUDE.md already discloses for the
  // play()/rebuild race. The wiring (processingClipId set synchronously
  // before any await, cleared in finally, both top-bar/transport-bar/
  // overlay gated on it identically to isExporting) is correct by
  // inspection; the test below instead confirms the editor is never left
  // stuck disabled afterward, the one piece of this that *is* provable.
  test("the editor is fully re-enabled after silence removal settles", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSegmentedWavFile("gaps.wav", SEGMENTS)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_SILENCE).click();
    await waitForWaveformReady(page);

    await expect(page.getByTestId("silence-removal-overlay")).toBeHidden();
    await expect(page.getByTestId("top-bar")).toHaveAttribute("aria-disabled", "false");
    await expect(page.getByTestId("transport-bar")).toHaveAttribute("aria-disabled", "false");
  });

  test("the success toast auto-dismisses on its own", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSegmentedWavFile("gaps.wav", SEGMENTS)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_SILENCE).click();
    await waitForWaveformReady(page);

    const toast = page.getByText("Silence removed.");
    await expect(toast).toBeVisible();
    // AUTO_DISMISS_MS is 5000 (Toast.tsx) — wait past it, then confirm gone
    // on its own, not just dismissible via the close button.
    await expect(toast).toBeHidden({ timeout: 6000 });
  });

  test("the spliced clip survives a reload and still plays", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSegmentedWavFile("gaps.wav", SEGMENTS)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_SILENCE).click();
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

  test("a stereo clip keeps both channels distinct after silence removal — not collapsed to mono", async ({
    page,
  }) => {
    // Regression test for a real bug found and fixed while building this:
    // createAudioBuffer's channelCount parameter defaults to 1, so an
    // omitted argument silently drops every channel past the first. Every
    // other fixture in this suite is mono, so that bug would pass every
    // other test here undetected.
    await gotoEditor(page);
    await uploadFiles(page, [
      makeStereoSegmentedWavFile("stereo-gaps.wav", SEGMENTS, { leftAmplitude: 0.5, rightAmplitude: 0.2 }),
    ]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REMOVE_SILENCE).click();
    await waitForWaveformReady(page);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /Export/ }).click();
    const download = await downloadPromise;
    const wav = readWav(fs.readFileSync((await download.path())!));

    expect(wav.numChannels).toBe(2);
    // Well inside the first kept tone segment (starts at 0, padded cutoff
    // ~0.9s — see EXPECTED_KEPT_SECONDS), safely clear of any cut.
    const leftPeak = wav.maxAbsInWindow(0.3, 0.02, 0);
    const rightPeak = wav.maxAbsInWindow(0.3, 0.02, 1);
    expect(leftPeak).toBeGreaterThan(0.3); // left amplitude ~0.5
    expect(rightPeak).toBeGreaterThan(0.1); // right amplitude ~0.2
    // Genuinely different content, not the left channel duplicated onto
    // both — which is exactly what the channelCount bug above would produce.
    expect(rightPeak).toBeLessThan(leftPeak * 0.6);
  });

  /**
   * Remap-not-retranscribe — see TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's
   * Phase 4. `/api/transcribe` is mocked at the browser level; a request
   * counter proves the splice's new transcript came from the local remap
   * (utils/transcriptRemap.ts), not a second network call.
   */
  test("silence removal remaps the source transcript locally instead of re-transcribing", async ({ page }) => {
    await gotoEditor(page);

    let transcribeCallCount = 0;
    await page.route("**/api/transcribe", (route) => {
      transcribeCallCount++;
      const words = [
        { word: "one", start: 0.3, end: 0.6 }, // first tone [0,1) — kept
        { word: "stray", start: 1.5, end: 1.8 }, // first silence [1,2.5) — dropped
        { word: "two", start: 3.0, end: 3.3 }, // second tone [2.5,3.5) — kept
        { word: "gone", start: 4.0, end: 4.3 }, // second silence [3.5,5) — dropped
        { word: "three", start: 5.3, end: 5.6 }, // third tone [5,6) — kept
      ];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ words }) });
    });

    await uploadFiles(page, [makeSegmentedWavFile("gaps.wav", SEGMENTS)]);
    const original = await waitForTranscriptSettled(page);
    expect(transcribeCallCount).toBe(1);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    const commitStart = Date.now();
    await page.getByRole("menuitem", REMOVE_SILENCE).click();
    await expect(page.getByText("Silence removed.")).toBeVisible();

    // The new asset's transcript should appear essentially immediately —
    // real network latency (confirmed elsewhere in this suite's mocks, and
    // in practice against the real OpenRouter API) is at minimum tens of
    // milliseconds, typically hundreds+. A remap is synchronous local work.
    await expect
      .poll(async () => (await readTranscripts(page)).length, { timeout: 2000 })
      .toBe(2);
    const remapElapsedMs = Date.now() - commitStart;
    expect(remapElapsedMs).toBeLessThan(1000);

    // The real proof: no second call to /api/transcribe.
    expect(transcribeCallCount).toBe(1);

    const transcripts = await readTranscripts(page);
    const newTranscript = transcripts.find((t) => t.assetId !== original.assetId)!;
    expect(newTranscript.status).toBe("done");
    const words = newTranscript.words!.map((w) => w.word);
    expect(words).toEqual(["one", "two", "three"]); // stray/gone correctly dropped

    // "two" and "three" both shifted left (silence removed ahead of them) —
    // not left unshifted, which is what re-transcribing the *original*
    // audio unchanged would have produced.
    const originalTwo = original.words!.find((w) => w.word === "two")!;
    const remappedTwo = newTranscript.words!.find((w) => w.word === "two")!;
    expect(remappedTwo.start).toBeLessThan(originalTwo.start);
  });
});
