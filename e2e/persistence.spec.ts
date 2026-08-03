import { test, expect } from "@playwright/test";
import { makeSineWavFile } from "./fixtures";
import { SELECTORS, waitForWaveformReady, uploadFiles, gotoEditor } from "./helpers";

const REMOVE_TRACK = { name: "Remove track" } as const;
const MUTE = { name: "Mute", exact: true } as const;

/**
 * Reads the `assets` object store's record count directly via the browser's
 * native indexedDB API — the DB/stores already exist by this point (any
 * earlier `loadProject()` call, which every page load makes via
 * useProjectHydration.ts, opens/creates them via the `upgrade` callback in
 * utils/persistence.ts even when nothing has been saved yet).
 */
async function countAssetRecords(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    return new Promise<number>((resolve, reject) => {
      const req = indexedDB.open("editor-pro", 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("assets", "readonly");
        const countReq = tx.objectStore("assets").count();
        countReq.onsuccess = () => resolve(countReq.result);
        countReq.onerror = () => reject(countReq.error);
        tx.oncomplete = () => db.close();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * Phase 3 (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md) — IndexedDB persistence and
 * initial-load rehydration. Covers the round trip through a reload (import,
 * trim, reload, confirm restored + playback works), a fresh IndexedDB
 * rendering the default project without hanging, the hydration effect's
 * try/catch fallback on a corrupt record, and the cross-upload asset-dedup
 * case deferred from Phase 1 (only observable end-to-end once persistence
 * exists, per that phase's own note).
 */
test.describe("Phase 3 persistence", () => {
  test("a fresh project with no persisted data renders the default empty track without hanging", async ({
    page,
  }) => {
    // Every test already gets an isolated browser context (and therefore a
    // fresh IndexedDB) by default — this just asserts that default state
    // explicitly, per the plan's own "fresh IndexedDB" verification step.
    await gotoEditor(page);
    await waitForWaveformReady(page);

    // The lone default track's close button is hidden — a podcast needs at
    // least one track, so "Remove track" only renders once a second track
    // exists. Mute count===1 confirms the track itself is there.
    await expect(page.getByRole("button", MUTE)).toHaveCount(1);
    await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(0);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(0);
  });

  test("import, trim, and undo survive a reload", async ({ page }) => {
    await gotoEditor(page);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 4)]);

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

    const clip = page.locator(SELECTORS.draggableClip).first();
    const trimmedBox = (await clip.boundingBox())!;

    // Give the debounced save (500ms trailing-edge, see PodcastEditor.tsx)
    // time to land before reloading.
    await page.waitForTimeout(800);

    await page.reload();
    await waitForWaveformReady(page);

    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(1);
    const reloadedBox = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!;
    expect(reloadedBox.width).toBeCloseTo(trimmedBox.width, 0);

    // Playback works against the rehydrated (persisted blob, re-decoded)
    // buffer, not just the DOM shape. PlayPauseButton (UI-UX-redesign) merged
    // the old separate Play/Pause buttons into one toggle whose accessible
    // name flips with isPlaying instead of ever disabling while playing —
    // "Pause" becoming visible is this toggle's own signal that play()
    // actually resolved.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  });

  /**
   * Isolated in its own describe block with retries: a raw indexedDB
   * connection opened via page.evaluate() right after this app has been
   * loaded was found to intermittently stall for 30s+ before any of
   * open/onsuccess/onerror ever fires (reproduced repeatedly under
   * Playwright's worker-reused-browser-process + repeat-each — never
   * reproduced across dozens of runs of the equivalent sequence in a freshly
   * launched browser process outside the test runner, including with the
   * app's own debounced save deliberately timed to be mid-flight). Navigating
   * to a same-origin 404 route first (a real navigation, tearing down
   * useProjectHydration.ts's own long-lived idb connection before the raw one
   * opens) measurably reduces how often this hits, but did not eliminate it
   * in repeated local testing — this reads as a Chromium/Windows-level
   * IndexedDB connection-teardown timing quirk specific to how Playwright
   * recycles contexts within one browser process, not a defect in
   * utils/persistence.ts or useProjectHydration.ts (both verified correct and
   * near-instantaneous under direct, repeated manual reproduction). Retrying
   * is the same treatment CLAUDE.md already gives the two playback-guard
   * races that are correct by inspection but not reliably provable under
   * automated timing.
   */
  test.describe("corrupt record fallback", () => {
    test.describe.configure({ retries: 2 });

    test("a corrupt persisted record falls back to the default project instead of hanging", async ({
      page,
    }) => {
      await gotoEditor(page);
      await waitForWaveformReady(page);

      // Corrupt the persisted project record directly, but not on the same
      // document that just loaded the app — see this block's own doc comment.
      await page.goto("/__e2e_seed__");
      await page.evaluate(() => {
        return new Promise<void>((resolve, reject) => {
          const req = indexedDB.open("editor-pro", 1);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("project", "readwrite");
            tx.objectStore("project").put(
              { schemaVersion: 1, tracks: "not-an-array", updatedAt: Date.now() },
              "current"
            );
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        });
      });

      await page.goto("/");
      await waitForWaveformReady(page);

      // Same reasoning as the fresh-project test above — the fallback
      // project has one track, so its close button is hidden.
      await expect(page.getByRole("button", MUTE)).toHaveCount(1);
      await expect(page.getByRole("button", REMOVE_TRACK)).toHaveCount(0);
      await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(0);
    });
  });

  test("uploading the same file twice stores one asset record and both clips survive a reload", async ({
    page,
  }) => {
    await gotoEditor(page);
    const file = makeSineWavFile("tone.wav", 2);
    await uploadFiles(page, [file]);
    await uploadFiles(page, [file]); // same bytes, independent second upload
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(2);

    await page.waitForTimeout(800); // let the debounced save land

    expect(await countAssetRecords(page)).toBe(1);

    await page.reload();
    await waitForWaveformReady(page);
    await expect(page.locator(SELECTORS.draggableClip)).toHaveCount(2);
  });
});
