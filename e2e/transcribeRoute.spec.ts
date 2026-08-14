import { test, expect } from "@playwright/test";

// Set before importing route.ts — POST reads process.env.OPENROUTER_API_KEY
// at request time (inside the handler, not at module load), so the exact
// ordering relative to the import below doesn't actually matter for
// correctness, but doing it first keeps the intent obvious to a reader. Same
// pattern ttsRoute.spec.ts already establishes for CARTESIA_API_KEY.
process.env.OPENROUTER_API_KEY = "test-key";

// Imports route.ts directly and mocks global.fetch — deliberately NOT run
// through the built/served Next app. Same reasoning ttsRoute.spec.ts's own
// doc comment already documents for /api/tts: mocking **/api/transcribe at
// the browser level (transcription.spec.ts) is real coverage of the
// client's reaction, zero coverage of this route's own logic (validation,
// the outgoing OpenRouter request shape, the retry behavior below); hitting
// the shared webServer over HTTP instead risks a real call to OpenRouter if
// a developer's own already-running `npm run start` gets reused via
// playwright.config.ts's `reuseExistingServer: !process.env.CI`.
import { POST } from "../src/app/api/transcribe/route";

function transcribeRequest(file: Blob | null): Request {
  const form = new FormData();
  if (file) form.append("file", file, "chunk.ogg");
  return new Request("http://localhost/api/transcribe", { method: "POST", body: form });
}

function testFile(content = "fake-opus-bytes"): Blob {
  return new Blob([content], { type: "audio/ogg" });
}

function okOpenRouterResponse(words: { word: string; start: number; end: number }[]): Response {
  return new Response(JSON.stringify({ text: words.map((w) => w.word).join(" "), words }), { status: 200 });
}

test.describe("POST /api/transcribe", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("sends the file, model, and word-level timestamp params to OpenRouter", async () => {
    let capturedForm!: FormData;
    let capturedHeaders!: Headers;
    global.fetch = (async (_url, init) => {
      capturedForm = init!.body as FormData;
      capturedHeaders = new Headers(init!.headers);
      return okOpenRouterResponse([{ word: "hello", start: 0, end: 0.5 }]);
    }) as typeof fetch;

    const response = await POST(transcribeRequest(testFile()));

    expect(response.status).toBe(200);
    expect(capturedForm.get("model")).toBe("openai/whisper-large-v3");
    expect(capturedForm.get("response_format")).toBe("verbose_json");
    expect(capturedForm.get("timestamp_granularities[]")).toBe("word");
    expect(capturedForm.get("file")).toBeInstanceOf(Blob);
    expect(capturedHeaders.get("Authorization")).toBe("Bearer test-key");

    const body = await response.json();
    expect(body.words).toEqual([{ word: "hello", start: 0, end: 0.5 }]);
  });

  test("rejects a request with no file before ever calling OpenRouter", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okOpenRouterResponse([]);
    }) as typeof fetch;

    const response = await POST(transcribeRequest(null));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects an empty (zero-byte) file before ever calling OpenRouter", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okOpenRouterResponse([]);
    }) as typeof fetch;

    const response = await POST(transcribeRequest(new Blob([], { type: "audio/ogg" })));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("retries once on a 429 from OpenRouter and succeeds on the second attempt", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return callCount === 1
        ? new Response("rate limited", { status: 429 })
        : okOpenRouterResponse([{ word: "hi", start: 0, end: 0.3 }]);
    }) as typeof fetch;

    const response = await POST(transcribeRequest(testFile()));

    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test("does not retry a 404 and forwards a clean error instead", async () => {
    // Same reasoning ttsRoute.spec.ts's equivalent test documents: a 4xx is a
    // deterministic client-input problem (bad format/model), retrying it
    // only delays the same inevitable failure — only 429/5xx are retried
    // (see route.ts's own doc comment).
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response("Unsupported format", { status: 404 });
    }) as typeof fetch;

    const response = await POST(transcribeRequest(testFile()));

    expect(response.status).toBe(502);
    expect(callCount).toBe(1);
    const body = await response.json();
    expect(body.error).toContain("Transcription failed");
  });

  test("gives up after exhausting retries on repeated 500s", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response("server error", { status: 500 });
    }) as typeof fetch;

    const response = await POST(transcribeRequest(testFile()));

    expect(response.status).toBe(502);
    expect(callCount).toBe(2); // MAX_ATTEMPTS, not unbounded
  });

  test("treats a missing/non-array `words` field as a clean failure, not an empty success", async () => {
    // Real gap this route explicitly guards against: some providers
    // OpenRouter can route this model to don't honor
    // timestamp_granularities and just omit `words` entirely — see route.ts's
    // own doc comment.
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response(JSON.stringify({ text: "hello there" /* no words field */ }), { status: 200 });
    }) as typeof fetch;

    const response = await POST(transcribeRequest(testFile()));

    expect(response.status).toBe(502);
    expect(callCount).toBe(1); // a 200 is not a retryable status, even with a bad payload
    const body = await response.json();
    expect(body.error).toContain("word-level timestamps");
  });

  test("returns 500 with a clear message when OPENROUTER_API_KEY is unset", async () => {
    const original = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const response = await POST(transcribeRequest(testFile()));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("OPENROUTER_API_KEY");
    } finally {
      process.env.OPENROUTER_API_KEY = original;
    }
  });
});
