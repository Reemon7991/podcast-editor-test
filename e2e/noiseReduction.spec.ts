import { test, expect, type Page } from "@playwright/test";
import { makeSineWavFile, makeSineWavBuffer } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor, clipActionsButtonFor } from "./helpers";

const UNDO = { name: "Undo" } as const;
const REDUCE_NOISE = { name: /^Reduce noise$|^Reducing noise…$/ } as const;

/**
 * "Reduce noise" — see NOISE_REDUCTION_PLAN.md. No real Replicate call in any
 * of these: every test mocks `**\/api/noise-reduction*` via page.route,
 * reusing fixtures.ts's makeSineWavBuffer for the mocked "denoised" result
 * body — same technique tts.spec.ts already uses for `**\/api/tts`.
 * Route-level coverage (validation, provider delegation, response shaping)
 * lives in noiseReductionRoute.spec.ts instead — this file only covers
 * client-side behavior these mocks can't reach: the poll-to-completion path,
 * the app-wide single-flight guard (and that it does NOT block anything
 * else, per the whole point of this feature), the live-clip recheck, and
 * undo.
 *
 * useNoiseReduction.ts always sleeps one POLL_INTERVAL_MS (3s) before its
 * first status check, even for an instantly-resolved mock job — every test
 * below budgets for that.
 */

interface MockOptions {
  /** How many "processing" polls to answer before switching to "succeeded" —
   *  0 means the very first poll already reports success. */
  succeedAfterPolls?: number;
  /** Duration of the mocked "denoised" result audio — deliberately different
   *  from the uploaded clip's own duration in most tests below, so a clip
   *  width change is directly observable, the same technique
   *  silenceRemoval.spec.ts already uses. */
  resultDurationSeconds?: number;
  /** When false, the create call itself fails (a Replicate/network error),
   *  never reaching the poll loop at all. */
  createSucceeds?: boolean;
}

const JOB_ID = "test-job";

async function mockNoiseReductionApi(
  page: Page,
  { succeedAfterPolls = 0, resultDurationSeconds = 1, createSucceeds = true }: MockOptions = {}
) {
  let pollCount = 0;

  await page.route(`**/api/noise-reduction`, async (route) => {
    if (!createSucceeds) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "Failed to start noise reduction. Please try again." }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: JOB_ID }) });
  });

  await page.route(`**/api/noise-reduction/${JOB_ID}`, async (route) => {
    pollCount++;
    const status = pollCount > succeedAfterPolls ? "succeeded" : "processing";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status }) });
  });

  await page.route(`**/api/noise-reduction/${JOB_ID}/result`, async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/wav", body: makeSineWavBuffer(resultDurationSeconds) });
  });
}

test.describe("Reduce noise", () => {
  test("a successful job replaces the clip, shows a toast, and undo restores the original in one step", async ({
    page,
  }) => {
    await gotoEditor(page);
    await mockNoiseReductionApi(page, { resultDurationSeconds: 1 });
    await uploadFiles(page, [makeSineWavFile("clip.wav", 3)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const originalWidth = (await clip.boundingBox())!.width;

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REDUCE_NOISE).click();

    await expect(page.getByText("Noise reduced.")).toBeVisible({ timeout: 10_000 });
    await waitForWaveformReady(page);

    // Noise reduction replaces the clip with a fresh id (a new asset) — the
    // mocked result is 1s vs. the original 3s upload, so a narrower clip is
    // direct evidence the replacement actually landed, not just the toast.
    const reducedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(reducedWidth).toBeLessThan(originalWidth * 0.6);

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);

    const restoredWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(restoredWidth).toBeCloseTo(originalWidth, -1);
  });

  test("disables Reduce noise on every clip while one job is running, but leaves everything else usable", async ({
    page,
  }) => {
    await gotoEditor(page);
    // Never resolves within this test's lifetime — this test only cares
    // about the in-flight window, not completion.
    await mockNoiseReductionApi(page, { succeedAfterPolls: 1000 });
    await uploadFiles(page, [makeSineWavFile("a.wav", 2), makeSineWavFile("b.wav", 2)]);

    const clips = page.locator(SELECTORS.draggableClip);
    await expect(clips).toHaveCount(2);
    const clipA = clips.nth(0);
    const clipB = clips.nth(1);

    await clipA.hover();
    await (await clipActionsButtonFor(page, clipA)).click();
    await page.getByRole("menuitem", REDUCE_NOISE).click();

    // In flight now (the mocked status route never reports "succeeded").
    // Confirm the *other* clip's own menu item is disabled too — app-wide
    // single-flight, not per-clip (see useNoiseReduction.ts). Only the clip
    // actually running shows the busy "Reducing noise…" label; every other
    // clip's item still reads "Reduce noise", just disabled.
    await clipB.hover();
    await (await clipActionsButtonFor(page, clipB)).click();
    await expect(page.getByRole("menuitem", { name: "Reduce noise", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");

    // Export is the one thing this feature deliberately also disables while
    // a job is in flight (see NOISE_REDUCTION_PLAN.md's "Guards worth
    // including" and EditorShell.tsx's own doc comment on exportDisabled).
    await expect(page.getByRole("button", { name: /Export/ })).toBeDisabled();

    // Everything else keeps working: duplicate a *different* clip, and undo
    // it — both plain commit()s, unrelated to the still-running job.
    await clipB.hover();
    await (await clipActionsButtonFor(page, clipB)).click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await waitForWaveformReady(page);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(3);

    await page.getByRole("button", UNDO).click();
    await waitForWaveformReady(page);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(2);

    // Playback also stays available.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  });

  test("trimming the target clip while its job is running discards the result on completion", async ({ page }) => {
    await gotoEditor(page);
    // Two processing polls (6s) leaves a real window to perform the trim
    // drag below before the third poll reports "succeeded".
    await mockNoiseReductionApi(page, { succeedAfterPolls: 2, resultDurationSeconds: 1 });
    await uploadFiles(page, [makeSineWavFile("clip.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REDUCE_NOISE).click();

    const rightHandle = page.locator('[data-boundary-edge="right"]').first();
    const box = (await rightHandle.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 10, startY, { steps: 5 });
    await page.mouse.move(startX - 60, startY, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    const trimmedWidth = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;

    await expect(
      page.getByText("This clip changed while noise reduction was running — the result was discarded. Try again.")
    ).toBeVisible({ timeout: 12_000 });

    // Trimmed state survives untouched — the stale result was never applied.
    const widthAfterDiscard = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width;
    expect(widthAfterDiscard).toBeCloseTo(trimmedWidth, 0);
  });

  test("moving a different clip while a job runs does not discard the result", async ({ page }) => {
    await gotoEditor(page);
    await mockNoiseReductionApi(page, { succeedAfterPolls: 1, resultDurationSeconds: 1 });
    await uploadFiles(page, [makeSineWavFile("a.wav", 2), makeSineWavFile("b.wav", 2)]);

    const clips = page.locator(SELECTORS.draggableClip);
    const clipA = clips.nth(0);
    const clipB = clips.nth(1);

    await clipA.hover();
    await (await clipActionsButtonFor(page, clipA)).click();
    await page.getByRole("menuitem", REDUCE_NOISE).click();

    // Move the *other* clip (B), not the one being processed — the plain
    // move this feature is explicitly designed to tolerate (see
    // useNoiseReduction.ts's own doc comment on the live-clip recheck).
    const boxB = (await clipB.boundingBox())!;
    await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2);
    await page.mouse.down();
    await page.mouse.move(boxB.x + boxB.width / 2 + 10, boxB.y + boxB.height / 2, { steps: 5 });
    await page.mouse.move(boxB.x + boxB.width / 2 + 150, boxB.y + boxB.height / 2, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    await expect(page.getByText("Noise reduced.")).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText("This clip changed while noise reduction was running", { exact: false })
    ).toHaveCount(0);
  });

  test("a failed job shows an error toast and leaves the clip untouched", async ({ page }) => {
    await gotoEditor(page);
    await mockNoiseReductionApi(page, { createSucceeds: false });
    await uploadFiles(page, [makeSineWavFile("clip.wav", 2)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const widthBefore = (await clip.boundingBox())!.width;

    await clip.hover();
    await (await clipActionsButtonFor(page, clip)).click();
    await page.getByRole("menuitem", REDUCE_NOISE).click();

    await expect(page.getByText("Noise reduction failed. Please try again.")).toBeVisible();
    expect((await page.locator(SELECTORS.draggableClip).first().boundingBox())!.width).toBeCloseTo(
      widthBefore,
      0
    );
  });
});
