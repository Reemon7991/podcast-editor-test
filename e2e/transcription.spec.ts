import { test, expect } from "@playwright/test";
import { makeSineWavFile, makeSineWavBuffer } from "./fixtures";
import {
  SELECTORS,
  waitForWaveformReady,
  uploadFiles,
  gotoEditor,
  countIndexedDbRecords,
  readTranscripts,
  waitForTranscriptSettled,
  mockTranscribeRoute,
} from "./helpers";

const MOCK_WORDS = [
  { word: "hello", start: 0.1, end: 0.4 },
  { word: "world", start: 0.5, end: 0.9 },
];

const ADD_CLIP_BUTTON = { name: "Clip" } as const;
const GENERATE = { name: "Generate", exact: true } as const;
const GENERATE_MODAL = { name: "Generate clip (AI)" } as const;

/**
 * Compression + background transcription — see
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phases 1-3. `/api/transcribe`
 * is mocked at the browser level throughout (see helpers.ts's
 * mockTranscribeRoute doc comment on why — this is the same split
 * tts.spec.ts/ttsRoute.spec.ts already establish); the underlying WAV
 * content is irrelevant to what these tests check, since the mocked route
 * returns a fixed transcript regardless of what audio was actually sent.
 *
 * **A real race, found while writing this suite**: `uploadFiles()`'s
 * `waitForWaveformReady()` (waits for "Building waveform…" to hide) is safe
 * for asserting decode/import finished, but NOT safe for asserting
 * compression finished. `commit()` — the thing that eventually triggers the
 * rebuild "Building waveform…" reflects — only fires *after* compression
 * has already been awaited (see useTimelineTracks.ts's addFilesToTrack), so
 * the causality is correct in the app... but the placeholder itself only
 * starts showing once that rebuild actually begins. Compression can take a
 * few real seconds (Opus-encoding via mediabunny, unlike a synthetic clip's
 * near-instant decode), long enough that `waitFor({state:"hidden"})` can
 * observe zero matches — trivially "hidden" — *before* the placeholder ever
 * had a chance to appear, not after it cleared. Confirmed directly: checking
 * `compressedAssets` immediately after `uploadFiles()` intermittently read 0,
 * then 1 a few seconds later with no other change. Same class of "a
 * DOM-text placeholder is not a reliable automated completion signal" issue
 * CLAUDE.md already documents for the hydration/"Building waveform…"
 * sequencing — the fix here is the same shape: poll the actual outcome
 * (`waitForTranscriptSettled`) instead of trusting placeholder timing.
 * Because `saveCompressedAsset` always resolves before
 * `runTranscriptionPipeline` is even invoked, a settled transcript is proof
 * compression already finished — every test below checks the transcript
 * first, then compressedAssets, never the other way around.
 */
test.describe("Transcription pipeline", () => {
  test("uploading a clip persists a compressed-chunk record and a transcript that settles to 'done'", async ({
    page,
  }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);

    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const transcript = await waitForTranscriptSettled(page);
    expect(transcript.status).toBe("done");
    expect(transcript.words).toEqual(MOCK_WORDS);
    // Safe to check now — see this file's own doc comment above on why this
    // must come *after* waitForTranscriptSettled, not right after upload.
    expect(await countIndexedDbRecords(page, "compressedAssets")).toBe(1);
  });

  test("transcription runs in the background — the clip is editable immediately, without waiting for it", async ({
    page,
  }) => {
    await gotoEditor(page);
    // Never resolves — simulates transcription still being in flight well
    // past the point the clip has already finished importing.
    await page.route("**/api/transcribe", () => {});

    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    // Wait for compression to have actually finished and transcription to
    // have been kicked off — the intermediate "transcribing" status only
    // ever lives in the in-memory transcriptStore (saveTranscript, the
    // IndexedDB write, fires once at the very end — see
    // utils/transcription.ts), so `compressedAssets` reaching 1 is the
    // right *persisted, pollable* signal that the background work has
    // genuinely started, not just "hadn't begun yet."
    await expect
      .poll(async () => countIndexedDbRecords(page, "compressedAssets"), { timeout: 10000 })
      .toBe(1);

    // The clip is already draggable/interactive — dragging it a good
    // distance and confirming it actually moved is a real interaction, not
    // just a DOM-presence check.
    const clip = page.locator(SELECTORS.draggableClip).first();
    const before = (await clip.boundingBox())!;
    await clip.hover();
    await page.mouse.down();
    await page.mouse.move(before.x + 20, before.y + before.height / 2, { steps: 3 });
    await page.mouse.move(before.x + 150, before.y + before.height / 2, { steps: 10 });
    await page.mouse.up();
    await waitForWaveformReady(page);

    const after = (await page.locator(SELECTORS.draggableClip).first().boundingBox())!;
    expect(after.x).toBeGreaterThan(before.x + 60);

    // Still not settled (no IndexedDB transcripts record at all — see the
    // note above on why "transcribing" itself isn't observable this way)
    // — confirms the drag above genuinely happened while transcription was
    // still in flight, not after the never-resolving mock somehow settled.
    expect(await readTranscripts(page)).toEqual([]);
  });

  test("a TTS-generated clip is compressed and transcribed the same way an uploaded one is", async ({ page }) => {
    await gotoEditor(page);
    await waitForWaveformReady(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await page.route("**/api/tts", (route) =>
      route.fulfill({ status: 200, contentType: "audio/wav", body: makeSineWavBuffer(2) })
    );

    await page.getByRole("button", ADD_CLIP_BUTTON).click();
    await page.getByRole("menuitem", { name: "Generate clip (AI)" }).click();
    await page.getByPlaceholder("Type the words you want spoken…").fill("Hello from the test suite");
    await page.getByRole("button", GENERATE).click();
    await waitForWaveformReady(page);
    await expect(page.getByRole("dialog", GENERATE_MODAL)).toHaveCount(0);

    const transcript = await waitForTranscriptSettled(page);
    expect(transcript.status).toBe("done");
    expect(transcript.words).toEqual(MOCK_WORDS);
    expect(await countIndexedDbRecords(page, "compressedAssets")).toBe(1);
  });

  test("a chunk request that fails settles the transcript to 'failed', not stuck forever", async ({ page }) => {
    await gotoEditor(page);
    await page.route("**/api/transcribe", (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
    );

    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);

    const transcript = await waitForTranscriptSettled(page);
    expect(transcript.status).toBe("failed");
    expect(transcript.words).toBeNull();
  });

  test("the transcripts IndexedDB record survives a reload", async ({ page }) => {
    await gotoEditor(page);
    await mockTranscribeRoute(page, MOCK_WORDS);
    await uploadFiles(page, [makeSineWavFile("tone.wav", 2)]);
    await waitForTranscriptSettled(page);

    // Give the debounced project save (500ms, see PodcastEditor.tsx) time to
    // land — same wait persistence.spec.ts's own reload tests already use.
    await page.waitForTimeout(800);
    await page.reload();
    await waitForWaveformReady(page);

    const transcripts = await readTranscripts(page);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].status).toBe("done");
    expect(transcripts[0].words).toEqual(MOCK_WORDS);
  });
});
