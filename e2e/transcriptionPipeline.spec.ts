import { test, expect } from "@playwright/test";
import { runTranscriptionPipeline } from "../src/utils/transcription";
import { useTranscriptStore } from "../src/store/transcriptStore";
import type { CompressedChunk } from "../src/utils/types";

/**
 * Direct, Node-level test of `runTranscriptionPipeline`'s multi-chunk
 * merge/offset math — same "plain in-process test, mock global.fetch" shape
 * as ttsRoute.spec.ts/transcribeRoute.spec.ts use for their route handlers.
 *
 * This is the committed regression test for the exact class of bug
 * previously only checked once, live, ad-hoc: an earlier session verified
 * the offset math by temporarily lowering CHUNK_DURATION_SECONDS and
 * uploading a real multi-chunk clip through the whole browser pipeline (see
 * CLAUDE.md's "Transcription pipeline + Audio search" and
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 3) — that one-time check
 * is now permanent, fast (~milliseconds, no browser/audio needed), and runs
 * on every build.
 *
 * `saveTranscript`'s own IndexedDB write (persistence.ts) fails silently
 * here — there's no `indexedDB` global in this plain-Node context — but
 * `transcription.ts` already treats that as a non-fatal, logged-and-
 * swallowed side effect (see its own doc comment), so it doesn't affect
 * what's under test: `runTranscriptionPipeline`'s in-memory result via
 * `transcriptStore`.
 *
 * Each chunk's fake `Blob` carries a plain-text marker instead of real audio
 * — the mocked `global.fetch` reads it back via `FormData.get("file")` to
 * decide which canned response belongs to which chunk, letting one test
 * simulate several chunks resolving with distinct, chunk-relative word
 * timestamps.
 */

function chunk(marker: string, startSample: number, endSample: number): CompressedChunk {
  return { startSample, endSample, blob: new Blob([marker], { type: "audio/ogg" }) };
}

async function markerOf(init: RequestInit): Promise<string> {
  const form = init.body as FormData;
  const file = form.get("file") as Blob;
  return file.text();
}

test.describe("runTranscriptionPipeline (transcription.ts)", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("offsets each chunk's words by its own startSample and merges them in ascending order", async () => {
    const sampleRate = 16000;
    const chunks = [chunk("chunk-0", 0, 8 * sampleRate), chunk("chunk-1", 8 * sampleRate, 16 * sampleRate)];

    const wordsByMarker: Record<string, { word: string; start: number; end: number }[]> = {
      "chunk-0": [
        { word: "alpha", start: 1.0, end: 1.5 },
        { word: "bravo", start: 5.0, end: 5.5 },
      ],
      // chunk-relative — 1.5s into chunk-1, which itself starts 8s into the asset.
      "chunk-1": [{ word: "charlie", start: 1.5, end: 2.0 }],
    };
    global.fetch = (async (_url, init) => {
      const marker = await markerOf(init!);
      return new Response(JSON.stringify({ words: wordsByMarker[marker] }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-multi-chunk-${Date.now()}`;
    await runTranscriptionPipeline(assetId, chunks, sampleRate);

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.partialFailure).toBeFalsy();
    expect(transcript.words?.map((w) => w.word)).toEqual(["alpha", "bravo", "charlie"]);
    expect(transcript.words?.[0].start).toBeCloseTo(1.0, 5);
    expect(transcript.words?.[1].start).toBeCloseTo(5.0, 5);
    // The key assertion: chunk-1's word is offset by its own chunk start
    // (8s), landing at 9.5s — not reset near 0, which is exactly the bug
    // class the original live verification was checking for.
    expect(transcript.words?.[2].start).toBeCloseTo(9.5, 5);
  });

  test("three chunks merge in the right order even when requests settle out of order", async () => {
    const sampleRate = 16000;
    const chunks = [
      chunk("c0", 0, 10 * sampleRate),
      chunk("c1", 10 * sampleRate, 20 * sampleRate),
      chunk("c2", 20 * sampleRate, 30 * sampleRate),
    ];
    const wordsByMarker: Record<string, { word: string; start: number; end: number }[]> = {
      c0: [{ word: "first", start: 0.5, end: 1.0 }],
      c1: [{ word: "second", start: 0.5, end: 1.0 }],
      c2: [{ word: "third", start: 0.5, end: 1.0 }],
    };
    // Deliberately resolve out of chunk order (c2 fastest, c0 slowest) — the
    // final sort in runTranscriptionPipeline must still produce chronological
    // output regardless of settlement order.
    const delayByMarker: Record<string, number> = { c0: 30, c1: 15, c2: 0 };
    global.fetch = (async (_url, init) => {
      const marker = await markerOf(init!);
      await new Promise((r) => setTimeout(r, delayByMarker[marker]));
      return new Response(JSON.stringify({ words: wordsByMarker[marker] }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-out-of-order-${Date.now()}`;
    await runTranscriptionPipeline(assetId, chunks, sampleRate);

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.words?.map((w) => w.word)).toEqual(["first", "second", "third"]);
  });

  test("partial failure: surviving chunks still merge, status stays done, partialFailure is disclosed", async () => {
    const sampleRate = 16000;
    const chunks = [chunk("ok-chunk", 0, 8 * sampleRate), chunk("bad-chunk", 8 * sampleRate, 16 * sampleRate)];

    global.fetch = (async (_url, init) => {
      const marker = await markerOf(init!);
      if (marker === "bad-chunk") return new Response("server error", { status: 500 });
      return new Response(JSON.stringify({ words: [{ word: "survived", start: 0.2, end: 0.6 }] }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-partial-failure-${Date.now()}`;
    await runTranscriptionPipeline(assetId, chunks, sampleRate);

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.partialFailure).toBe(true);
    expect(transcript.error).toContain("1 of 2");
    expect(transcript.words?.map((w) => w.word)).toEqual(["survived"]);
  });

  test("total failure: every chunk fails, status is failed with no words", async () => {
    const sampleRate = 16000;
    const chunks = [chunk("c0", 0, 8 * sampleRate)];
    global.fetch = (async () => new Response("server error", { status: 500 })) as typeof fetch;

    const assetId = `test-total-failure-${Date.now()}`;
    await runTranscriptionPipeline(assetId, chunks, sampleRate);

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("failed");
    expect(transcript.words).toBeNull();
    expect(transcript.error).toBeTruthy();
  });

  test("a single-chunk asset (the common case) still works correctly", async () => {
    const sampleRate = 16000;
    const chunks = [chunk("only-chunk", 0, 5 * sampleRate)];
    global.fetch = (async () =>
      new Response(JSON.stringify({ words: [{ word: "hi", start: 0.1, end: 0.4 }] }), { status: 200 })) as typeof fetch;

    const assetId = `test-single-chunk-${Date.now()}`;
    await runTranscriptionPipeline(assetId, chunks, sampleRate);

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.words).toEqual([{ word: "hi", start: 0.1, end: 0.4 }]);
  });

  test("sets status to 'transcribing' synchronously before any chunk request resolves", async () => {
    const sampleRate = 16000;
    const chunks = [chunk("c0", 0, 5 * sampleRate)];
    let resolveResponse!: (r: Response) => void;
    global.fetch = (async () => new Promise<Response>((resolve) => { resolveResponse = resolve; })) as typeof fetch;

    const assetId = `test-transcribing-status-${Date.now()}`;
    const pipelinePromise = runTranscriptionPipeline(assetId, chunks, sampleRate);

    // Give the synchronous setTranscript("transcribing") call a chance to run
    // before the (still-pending) fetch resolves.
    await Promise.resolve();
    expect(useTranscriptStore.getState().transcripts[assetId]?.status).toBe("transcribing");

    resolveResponse(new Response(JSON.stringify({ words: [] }), { status: 200 }));
    await pipelinePromise;
    expect(useTranscriptStore.getState().transcripts[assetId]?.status).toBe("done");
  });
});
