import { test, expect } from "@playwright/test";
import { runTranscriptionPipeline, resumeTranscriptionPipeline } from "../src/utils/transcription";
import { useTranscriptStore } from "../src/store/transcriptStore";

/**
 * Direct, Node-level test of the submit-then-poll pipeline — same
 * "plain in-process test, mock global.fetch" shape as ttsRoute.spec.ts/
 * transcribeRoute.spec.ts use for their route handlers. `global.fetch` here
 * mocks the client's calls to this app's own relative-URL routes
 * (/api/transcribe, /api/transcribe/[id]), returning the same shape those
 * routes' own handlers produce (already-converted-to-seconds words) — the
 * routes' own AssemblyAI-facing logic is transcribeRoute.spec.ts's job.
 *
 * `saveTranscript`'s IndexedDB write fails silently here (no `indexedDB`
 * global in plain Node) — transcription.ts already treats that as
 * non-fatal/logged, so it doesn't affect what's under test:
 * `runTranscriptionPipeline`/`resumeTranscriptionPipeline`'s in-memory
 * result via transcriptStore.
 */

function testBlob(): Blob {
  return new Blob(["fake-opus-bytes"], { type: "audio/ogg" });
}

test.describe("runTranscriptionPipeline / resumeTranscriptionPipeline (transcription.ts)", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("submits, then settles to 'done' on the first poll", async () => {
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        return new Response(JSON.stringify({ transcriptId: "job-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ status: "done", words: [{ word: "hi", start: 0.1, end: 0.4 }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const assetId = `test-submit-done-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.providerJobId).toBe("job-1");
    expect(transcript.words).toEqual([{ word: "hi", start: 0.1, end: 0.4 }]);
  });

  test("keeps polling while status is 'transcribing', then settles to 'done'", async () => {
    let pollCount = 0;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        return new Response(JSON.stringify({ transcriptId: "job-2" }), { status: 200 });
      }
      pollCount++;
      if (pollCount === 1) return new Response(JSON.stringify({ status: "transcribing", words: null }), { status: 200 });
      return new Response(
        JSON.stringify({ status: "done", words: [{ word: "settled", start: 0, end: 0.3 }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const assetId = `test-multi-poll-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    expect(pollCount).toBe(2);
    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.words).toEqual([{ word: "settled", start: 0, end: 0.3 }]);
  });

  test("a job that settles to 'failed' is persisted as failed with the server's error message", async () => {
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        return new Response(JSON.stringify({ transcriptId: "job-3" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "failed", words: null, error: "boom" }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-job-failed-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("failed");
    expect(transcript.words).toBeNull();
    expect(transcript.error).toBe("boom");
  });

  test("a submit failure settles the transcript to 'failed' immediately, with no polling", async () => {
    let pollCalled = false;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
      }
      pollCalled = true;
      return new Response(JSON.stringify({ status: "done", words: [] }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-submit-fail-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    expect(pollCalled).toBe(false);
    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("failed");
    expect(transcript.providerJobId).toBeUndefined();
    expect(transcript.error).toBe("bad request");
  });

  test("sets status to 'transcribing' with the job id synchronously after submit, before polling resolves", async () => {
    let resolvePoll!: (r: Response) => void;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        return new Response(JSON.stringify({ transcriptId: "job-4" }), { status: 200 });
      }
      return new Promise<Response>((resolve) => {
        resolvePoll = resolve;
      });
    }) as typeof fetch;

    const assetId = `test-transcribing-status-${Date.now()}`;
    const pipelinePromise = runTranscriptionPipeline(assetId, testBlob());

    // Let the submit + synchronous setTranscript("transcribing") settle
    // before the still-pending poll resolves.
    await new Promise((r) => setTimeout(r, 50));
    const midFlight = useTranscriptStore.getState().transcripts[assetId];
    expect(midFlight.status).toBe("transcribing");
    expect(midFlight.providerJobId).toBe("job-4");

    resolvePoll(new Response(JSON.stringify({ status: "done", words: [] }), { status: 200 }));
    await pipelinePromise;
    expect(useTranscriptStore.getState().transcripts[assetId].status).toBe("done");
  });

  test("resumeTranscriptionPipeline polls an existing job without submitting a new one", async () => {
    let submitCalled = false;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        submitCalled = true;
        return new Response(JSON.stringify({ transcriptId: "should-not-happen" }), { status: 200 });
      }
      expect(urlStr).toContain("existing-job-id");
      return new Response(
        JSON.stringify({ status: "done", words: [{ word: "resumed", start: 0, end: 0.2 }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const assetId = `test-resume-${Date.now()}`;
    await resumeTranscriptionPipeline(assetId, "existing-job-id");

    expect(submitCalled).toBe(false);
    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.providerJobId).toBe("existing-job-id");
    expect(transcript.words).toEqual([{ word: "resumed", start: 0, end: 0.2 }]);
  });

  test("submit retries once on a network-level failure and succeeds on the second attempt", async () => {
    let submitAttempts = 0;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        submitAttempts++;
        if (submitAttempts === 1) throw new TypeError("network error");
        return new Response(JSON.stringify({ transcriptId: "job-5" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "done", words: [] }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-submit-retry-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    expect(submitAttempts).toBe(2);
    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.providerJobId).toBe("job-5");
  });

  test("submit fails clearly, with no polling, when both attempts fail at the network level", async () => {
    let submitAttempts = 0;
    let pollCalled = false;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        submitAttempts++;
        throw new TypeError("network error");
      }
      pollCalled = true;
      return new Response(JSON.stringify({ status: "done", words: [] }), { status: 200 });
    }) as typeof fetch;

    const assetId = `test-submit-double-fail-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    expect(submitAttempts).toBe(2);
    expect(pollCalled).toBe(false);
    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("failed");
    expect(transcript.providerJobId).toBeUndefined();
    expect(transcript.error).toContain("Transcription upload failed");
  });

  test("a poll fetch that throws, then one that returns a non-ok status, are both treated as not-yet-settled and retried until the job genuinely settles", async () => {
    let pollAttempts = 0;
    global.fetch = (async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/transcribe")) {
        return new Response(JSON.stringify({ transcriptId: "job-6" }), { status: 200 });
      }
      pollAttempts++;
      if (pollAttempts === 1) throw new TypeError("network error");
      if (pollAttempts === 2) return new Response("server error", { status: 500 });
      return new Response(
        JSON.stringify({ status: "done", words: [{ word: "recovered", start: 0, end: 0.2 }] }),
        { status: 200 }
      );
    }) as typeof fetch;

    const assetId = `test-poll-recovers-${Date.now()}`;
    await runTranscriptionPipeline(assetId, testBlob());

    expect(pollAttempts).toBe(3);
    const transcript = useTranscriptStore.getState().transcripts[assetId];
    expect(transcript.status).toBe("done");
    expect(transcript.words).toEqual([{ word: "recovered", start: 0, end: 0.2 }]);
  });
});
