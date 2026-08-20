import { test, expect } from "@playwright/test";

// Set before importing route.ts — POST/GET read process.env.ASSEMBLYAI_API_KEY
// at request time, so exact ordering doesn't matter for correctness, but
// doing it first keeps the intent obvious. Same pattern ttsRoute.spec.ts
// establishes for CARTESIA_API_KEY.
process.env.ASSEMBLYAI_API_KEY = "test-key";

// Imports both route handlers directly and mocks global.fetch — deliberately
// NOT run through the built/served Next app, same reasoning
// ttsRoute.spec.ts's own doc comment documents: mocking **/api/transcribe at
// the browser level (transcription.spec.ts) is real coverage of the client's
// reaction, zero coverage of these routes' own logic (validation, the
// outgoing AssemblyAI request shape, retry behavior, ms->s conversion).
import { POST } from "../src/app/api/transcribe/route";
import { GET } from "../src/app/api/transcribe/[id]/route";

function submitRequest(file: Blob | null): Request {
  const form = new FormData();
  if (file) form.append("file", file, "audio.ogg");
  return new Request("http://localhost/api/transcribe", { method: "POST", body: form });
}

function testFile(content = "fake-opus-bytes"): Blob {
  return new Blob([content], { type: "audio/ogg" });
}

function okUploadResponse(): Response {
  return new Response(JSON.stringify({ upload_url: "https://cdn.assemblyai.com/upload/fake-id" }), { status: 200 });
}

function okSubmitResponse(id = "job-123"): Response {
  return new Response(JSON.stringify({ id, status: "queued" }), { status: 200 });
}

test.describe("POST /api/transcribe (submit)", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("uploads the file, submits with the pinned options, and returns the job id", async () => {
    let uploadBody: unknown;
    let uploadHeaders!: Headers;
    let submitBody: Record<string, unknown> | undefined;
    let submitHeaders!: Headers;
    global.fetch = (async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("/v2/upload")) {
        uploadBody = init!.body;
        uploadHeaders = new Headers(init!.headers);
        return okUploadResponse();
      }
      submitBody = JSON.parse(init!.body as string);
      submitHeaders = new Headers(init!.headers);
      return okSubmitResponse();
    }) as typeof fetch;

    const response = await POST(submitRequest(testFile()));

    expect(response.status).toBe(200);
    expect(uploadBody).toBeInstanceOf(Blob);
    expect(uploadHeaders.get("authorization")).toBe("test-key");
    expect(uploadHeaders.get("Content-Type")).toBe("application/octet-stream");

    expect(submitBody?.audio_url).toBe("https://cdn.assemblyai.com/upload/fake-id");
    expect(submitBody?.speech_models).toEqual(["universal-3-5-pro"]);
    expect(submitBody?.disfluencies).toBe(true);
    expect(submitBody?.language_detection).toBe(true);
    expect(typeof submitBody?.prompt).toBe("string");
    expect(submitHeaders.get("authorization")).toBe("test-key");

    const body = await response.json();
    expect(body.transcriptId).toBe("job-123");
  });

  test("rejects a request with no file before ever calling AssemblyAI", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okUploadResponse();
    }) as typeof fetch;

    const response = await POST(submitRequest(null));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects an empty (zero-byte) file before ever calling AssemblyAI", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okUploadResponse();
    }) as typeof fetch;

    const response = await POST(submitRequest(new Blob([], { type: "audio/ogg" })));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("retries the upload once on a 429 and succeeds on the second attempt", async () => {
    let uploadAttempts = 0;
    global.fetch = (async (url) => {
      if (String(url).includes("/v2/upload")) {
        uploadAttempts++;
        return uploadAttempts === 1 ? new Response("rate limited", { status: 429 }) : okUploadResponse();
      }
      return okSubmitResponse();
    }) as typeof fetch;

    const response = await POST(submitRequest(testFile()));

    expect(response.status).toBe(200);
    expect(uploadAttempts).toBe(2);
  });

  test("retries the submit call once on a 5xx and succeeds on the second attempt", async () => {
    let submitAttempts = 0;
    global.fetch = (async (url) => {
      if (String(url).includes("/v2/upload")) return okUploadResponse();
      submitAttempts++;
      return submitAttempts === 1 ? new Response("server error", { status: 500 }) : okSubmitResponse();
    }) as typeof fetch;

    const response = await POST(submitRequest(testFile()));

    expect(response.status).toBe(200);
    expect(submitAttempts).toBe(2);
  });

  test("does not retry a 404 from the submit call and forwards a clean error instead", async () => {
    // A 4xx is a deterministic client-input problem — retrying it only
    // delays the same inevitable failure (see route.ts's own doc comment).
    let submitAttempts = 0;
    global.fetch = (async (url) => {
      if (String(url).includes("/v2/upload")) return okUploadResponse();
      submitAttempts++;
      return new Response("bad request", { status: 404 });
    }) as typeof fetch;

    const response = await POST(submitRequest(testFile()));

    expect(response.status).toBe(502);
    expect(submitAttempts).toBe(1);
    const body = await response.json();
    expect(body.error).toContain("Transcription failed");
  });

  test("returns 500 with a clear message when ASSEMBLYAI_API_KEY is unset", async () => {
    const original = process.env.ASSEMBLYAI_API_KEY;
    delete process.env.ASSEMBLYAI_API_KEY;
    try {
      const response = await POST(submitRequest(testFile()));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("ASSEMBLYAI_API_KEY");
    } finally {
      process.env.ASSEMBLYAI_API_KEY = original;
    }
  });
});

function statusRequest(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

test.describe("GET /api/transcribe/[id] (poll)", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("maps a queued/processing job to 'transcribing' with no words", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ status: "processing" }), { status: 200 })) as typeof fetch;

    const response = await GET(new Request("http://localhost/api/transcribe/job-1"), statusRequest("job-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "transcribing", words: null });
  });

  test("maps a completed job to 'done', converting word timestamps from ms to seconds", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          words: [
            { text: "hello", start: 100, end: 400, confidence: 0.99, speaker: null },
            { text: "world", start: 500, end: 900, confidence: 0.98, speaker: null },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    const response = await GET(new Request("http://localhost/api/transcribe/job-1"), statusRequest("job-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("done");
    expect(body.words).toEqual([
      { word: "hello", start: 0.1, end: 0.4 },
      { word: "world", start: 0.5, end: 0.9 },
    ]);
  });

  test("maps an errored job to 'failed', forwarding AssemblyAI's own error message", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ status: "error", error: "File not found" }), { status: 200 })) as typeof fetch;

    const response = await GET(new Request("http://localhost/api/transcribe/job-1"), statusRequest("job-1"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "failed", words: null, error: "File not found" });
  });

  test("treats a completed job with a missing/non-array words field as 'failed', not an empty success", async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ status: "completed" /* no words field */ }), { status: 200 })) as typeof fetch;

    const response = await GET(new Request("http://localhost/api/transcribe/job-1"), statusRequest("job-1"));

    const body = await response.json();
    expect(body.status).toBe("failed");
    expect(body.error).toContain("word-level timestamps");
  });

  test("returns 500 with a clear message when ASSEMBLYAI_API_KEY is unset", async () => {
    const original = process.env.ASSEMBLYAI_API_KEY;
    delete process.env.ASSEMBLYAI_API_KEY;
    try {
      const response = await GET(new Request("http://localhost/api/transcribe/job-1"), statusRequest("job-1"));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("ASSEMBLYAI_API_KEY");
    } finally {
      process.env.ASSEMBLYAI_API_KEY = original;
    }
  });

  test("returns 400 when no id is provided", async () => {
    const response = await GET(new Request("http://localhost/api/transcribe/"), statusRequest(""));
    expect(response.status).toBe(400);
  });
});
