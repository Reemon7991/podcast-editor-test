import { test, expect } from "@playwright/test";
import { makeSineWavBuffer } from "./fixtures";
import { MAX_TTS_TEXT_LENGTH } from "../src/utils/cartesiaVoices";

// Set before importing route.ts — POST reads process.env.CARTESIA_API_KEY at
// request time (inside the handler, not at module load), so the exact
// ordering relative to the import below doesn't actually matter for
// correctness, but doing it first keeps the intent obvious to a reader.
process.env.CARTESIA_API_KEY = "test-key";

// Imports route.ts directly and mocks global.fetch — deliberately NOT run
// through the built/served Next app the rest of this suite uses. Reasons:
//
// 1. e2e/tts.spec.ts mocks `**/api/tts` via page.route(), which intercepts
//    the request at the *browser* level — it never reaches this file at
//    all. That suite is real coverage of the client's reaction to various
//    responses, but zero coverage of this route's own logic (validation,
//    the outgoing Cartesia request shape, the retry behavior below).
// 2. Hitting the real, shared webServer instance over HTTP instead would
//    mean this route's outgoing call target has to be swapped to a local
//    mock via an env var set at that server's startup — but
//    playwright.config.ts's `reuseExistingServer: !process.env.CI` means a
//    developer's own already-running `npm run start` (pointed at the real
//    Cartesia API via their real .env.local) would silently get reused
//    instead, sending a real request to Cartesia during a test run. Calling
//    POST directly in-process sidesteps that risk entirely: it can never
//    reach the network unless this file's own mocked `global.fetch` lets it.
import { POST } from "../src/app/api/tts/route";

const VALID_VOICE_ID = "a0e99841-438c-4a64-b679-ae501e7d6091";

interface CartesiaRequestBody {
  transcript: string;
  voice: { mode: string; id: string };
  output_format: { container: string };
}

function ttsRequest(body: unknown): Request {
  return new Request("http://localhost/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function okCartesiaResponse(): Response {
  // Response's BodyInit type wants an ArrayBufferView, not a Node Buffer —
  // Buffer *is* one at runtime (it's a Uint8Array subclass) but TS's DOM
  // lib types don't know that, hence the explicit wrap.
  return new Response(new Uint8Array(makeSineWavBuffer(1)), { status: 200 });
}

test.describe("POST /api/tts", () => {
  let originalFetch: typeof fetch;

  test.beforeEach(() => {
    originalFetch = global.fetch;
  });

  test.afterEach(() => {
    global.fetch = originalFetch;
  });

  test("sends container: 'wav' and the requested voice id to Cartesia", async () => {
    // Definite-assignment assertion, not `| null = null`: the latter makes
    // TS's control-flow analysis narrow this to a `null`-only type after
    // declaration (it doesn't track the reassignment happening inside the
    // closure below), which then makes `capturedBody?.foo` an error
    // ("Property 'foo' does not exist on type 'never'") rather than the
    // intended optional-chained read. The assignment below is guaranteed to
    // run before the asserts (POST always calls fetch here) — if it somehow
    // didn't, reading a property off `undefined` fails the test just as
    // clearly.
    let capturedBody!: CartesiaRequestBody;
    global.fetch = (async (_url, init) => {
      capturedBody = JSON.parse(init!.body as string) as CartesiaRequestBody;
      return okCartesiaResponse();
    }) as typeof fetch;

    const response = await POST(ttsRequest({ text: "hello there", voiceId: VALID_VOICE_ID }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    // The one field this route pins deliberately — decodeAudioData on the
    // client can't decode headerless "raw" PCM, only a self-describing
    // container. See route.ts's own doc comment on this.
    expect(capturedBody.output_format.container).toBe("wav");
    expect(capturedBody.voice).toEqual({ mode: "id", id: VALID_VOICE_ID });
    expect(capturedBody.transcript).toBe("hello there");
  });

  test("retries once on a 429 from Cartesia and succeeds on the second attempt", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return callCount === 1 ? new Response("rate limited", { status: 429 }) : okCartesiaResponse();
    }) as typeof fetch;

    const response = await POST(ttsRequest({ text: "hello", voiceId: VALID_VOICE_ID }));

    expect(response.status).toBe(200);
    expect(callCount).toBe(2);
  });

  test("does not retry a 404 and forwards a clean error instead", async () => {
    // Regression test for the real incident this retry logic was added
    // after: a confirmed-valid voice id 404'd once, transiently, and
    // resolved on manual retry — but a 404 is also the correct, permanent
    // response for a genuinely bad id, so auto-retrying it would just delay
    // that failure rather than catch the transient case. Only 429/5xx are
    // retried (see route.ts's own doc comment on this choice).
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response("Voice not found", { status: 404 });
    }) as typeof fetch;

    const response = await POST(ttsRequest({ text: "hello", voiceId: VALID_VOICE_ID }));

    expect(response.status).toBe(502);
    expect(callCount).toBe(1);
    const body = await response.json();
    expect(body.error).toContain("Speech generation failed");
  });

  test("gives up after exhausting retries on repeated 500s", async () => {
    let callCount = 0;
    global.fetch = (async () => {
      callCount++;
      return new Response("server error", { status: 500 });
    }) as typeof fetch;

    const response = await POST(ttsRequest({ text: "hello", voiceId: VALID_VOICE_ID }));

    expect(response.status).toBe(502);
    expect(callCount).toBe(2); // MAX_ATTEMPTS, not unbounded
  });

  test("rejects an unknown voice id before ever calling Cartesia", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okCartesiaResponse();
    }) as typeof fetch;

    const response = await POST(ttsRequest({ text: "hello", voiceId: "not-a-real-voice" }));

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("rejects text over the shared length cap before ever calling Cartesia", async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return okCartesiaResponse();
    }) as typeof fetch;

    const response = await POST(
      ttsRequest({ text: "x".repeat(MAX_TTS_TEXT_LENGTH + 1), voiceId: VALID_VOICE_ID })
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("returns 500 with a clear message when CARTESIA_API_KEY is unset", async () => {
    const original = process.env.CARTESIA_API_KEY;
    delete process.env.CARTESIA_API_KEY;
    try {
      const response = await POST(ttsRequest({ text: "hello", voiceId: VALID_VOICE_ID }));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain("CARTESIA_API_KEY");
    } finally {
      process.env.CARTESIA_API_KEY = original;
    }
  });
});
