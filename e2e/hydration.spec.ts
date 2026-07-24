import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, rebuildsEngine } from "./helpers";

/**
 * Phase 1 (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md) sits hydrate()/dehydrate()
 * between app state and WaveformPlaylistProvider. Done naively, that would
 * defeat the provider's own `tracks === engineTracksRef.current` /
 * `isIncrementalAdd` rebuild-avoidance checks and turn routine edits like
 * add-track into full engine rebuilds. These tests assert the two caches
 * added to prevent that (TimelineStage.tsx's whole-array passthrough cache,
 * clipHydration.ts's per-track memoization) actually work — and that the
 * cases which *should* still rebuild (duplicate/delete) do.
 */
test.describe("Phase 1 hydration boundary — rebuild avoidance", () => {
  test("adding a track does not rebuild the engine", async ({ page }) => {
    await page.goto("/");
    await waitForWaveformReady(page);

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("button", { name: "+ New Track" }).click();
    });

    expect(rebuilt).toBe(false);
  });

  test("duplicating a clip rebuilds the engine", async ({ page }) => {
    await page.goto("/");
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await page.getByRole("button", { name: "Clip actions" }).click();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
    });

    expect(rebuilt).toBe(true);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(2);
  });

  test("deleting a clip rebuilds the engine", async ({ page }) => {
    await page.goto("/");
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await page.getByRole("button", { name: "Clip actions" }).click();

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.getByRole("menuitem", { name: "Delete" }).click();
    });

    expect(rebuilt).toBe(true);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(0);
  });

  test("splitting a clip does not rebuild the engine", async ({ page }) => {
    await page.goto("/");
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    await clip.hover();
    await page.getByRole("button", { name: "Clip actions" }).click();
    await page.getByRole("menuitem", { name: "Split" }).click();

    // Scissors mode is now armed — the next click on the clip commits the
    // split at that point (see useScissorsSplit.ts). Click at its own
    // (mid-clip) center, well clear of either boundary.
    const rebuilt = await rebuildsEngine(page, async () => {
      await clip.click();
    });

    expect(rebuilt).toBe(false);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(2);
  });

  test("dragging a clip along its track rebuilds the engine", async ({ page }) => {
    await page.goto("/");
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const box = (await clip.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const targetX = startX + 200;

    const rebuilt = await rebuildsEngine(page, async () => {
      // dnd-kit's PointerSensor needs real intermediate pointer movement past
      // its activation-distance threshold before it treats this as a drag
      // rather than a click — page.mouse.move/down/up (not locator.dragTo(),
      // which emulates HTML5 DnD, a different mechanism dnd-kit doesn't use)
      // to produce that.
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 10, startY, { steps: 5 });
      await page.mouse.move(targetX, startY, { steps: 10 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(true);
    const movedBox = await clip.boundingBox();
    expect(movedBox?.x).not.toBeCloseTo(box.x, 0);
  });

  test("dragging a clip to another track rebuilds the engine", async ({ page }) => {
    await page.goto("/");
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);
    await page.getByRole("button", { name: "+ New Track" }).click();
    await waitForWaveformReady(page);

    const clip = page.locator(SELECTORS.draggableClip).first();
    const box = (await clip.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // The per-track control label ("Track 2", plain text in the controls
    // banner, not interactive) is a reliable Y anchor for that track's row —
    // same approach EditorShell.tsx's own track-click detection and
    // ClipDragLayer's cross-track target detection already rely on.
    const track2Box = (await page.getByText("Track 2", { exact: true }).boundingBox())!;
    const targetY = track2Box.y + track2Box.height / 2;

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX, startY + 15, { steps: 5 });
      await page.mouse.move(startX, targetY, { steps: 10 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(true);
    const movedBox = await clip.boundingBox();
    expect(movedBox?.y).not.toBeCloseTo(box.y, 0);
  });

  test("trimming a clip does not rebuild the engine", async ({ page }) => {
    await page.goto("/");
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

    const rightHandle = page.locator('[data-boundary-edge="right"]').first();
    const box = (await rightHandle.boundingBox())!;
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    const rebuilt = await rebuildsEngine(page, async () => {
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX - 10, startY, { steps: 5 });
      await page.mouse.move(startX - 60, startY, { steps: 10 });
      await page.mouse.up();
    });

    expect(rebuilt).toBe(false);
  });
});
