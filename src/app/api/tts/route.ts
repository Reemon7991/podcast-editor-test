import { isKnownCartesiaVoiceId, MAX_TTS_TEXT_LENGTH } from "../../../utils/cartesiaVoices";

/**
 * Backend-owned TTS generation — see TTS_CARTESIA_PLAN.md for the full
 * design. The client never talks to Cartesia directly: this route holds the
 * server-only API key, calls Cartesia's synchronous bytes endpoint, and
 * returns finished audio straight through. Standard App Router Route
 * Handler (confirmed against this repo's bundled Next.js docs under
 * node_modules/next/dist/docs — no bleeding-edge surprises for a plain POST
 * handler; POST is never cached regardless of any route segment config).
 *
 * Exercised directly (not just via the app's own UI) by
 * `e2e/ttsRoute.spec.ts`, which imports `POST` and mocks `global.fetch` —
 * `e2e/tts.spec.ts` mocks `**\/api/tts` at the *browser* level instead
 * (`page.route`), which never actually reaches this file at all, so that
 * suite alone was never proof this route's own logic (validation, the
 * outgoing request shape, retry behavior below) does the right thing.
 */

const CARTESIA_TIMEOUT_MS = 30_000;

// Cartesia's synchronous "bytes" TTS endpoint. Exact path, header names, and
// request/response field names below are this session's best knowledge of
// Cartesia's API and were flagged in TTS_CARTESIA_PLAN.md as needing
// reconfirmation against Cartesia's current docs before shipping — do that
// before relying on this in production. `output_format.container: "wav"` is
// the one field pinned deliberately (not left open): `decodeAudioData` on
// the client can only decode a self-describing container, never headerless
// raw PCM, so this must stay "wav" regardless of what else changes here —
// asserted directly by e2e/ttsRoute.spec.ts, not just this comment.
const CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_API_VERSION = "2024-06-10";
const CARTESIA_MODEL_ID = "sonic-2";

// One retry, only for responses that signal a transient *upstream* problem
// (429 rate limit, 5xx) — added after a real, self-resolving 404 was
// observed during manual testing against a confirmed-valid voice id (see
// cartesiaVoices.ts's own doc comment on that incident). Deliberately NOT
// retried: 400/404 and other 4xx, which are deterministic client-input
// problems (bad text, unknown/genuinely-missing voice) — retrying those
// just delays the same inevitable failure instead of surfacing it sooner.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GenerateSpeechRequestBody {
  text?: unknown;
  voiceId?: unknown;
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** One attempt against Cartesia, with its own AbortController/timeout — a
 *  retried second attempt gets a fresh timeout budget rather than sharing
 *  one across both, so a slow-but-eventually-successful retry isn't
 *  penalized for time already spent on the first attempt. */
async function requestCartesiaTts(text: string, voiceId: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARTESIA_TIMEOUT_MS);
  try {
    return await fetch(CARTESIA_TTS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "Cartesia-Version": CARTESIA_API_VERSION,
      },
      body: JSON.stringify({
        model_id: CARTESIA_MODEL_ID,
        transcript: text,
        voice: { mode: "id", id: voiceId },
        // "wav" is required, not just preferred — see the doc comment above.
        output_format: { container: "wav", encoding: "pcm_s16le", sample_rate: 44100 },
        language: "en",
      }),
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Retries only on a retryable status, up to `MAX_ATTEMPTS` total attempts.
 *  A thrown network/timeout error (AbortError included) is NOT retried here
 *  — it propagates straight to POST's own catch block, same as before this
 *  retry logic existed. */
async function requestCartesiaTtsWithRetry(text: string, voiceId: string, apiKey: string): Promise<Response> {
  let response = await requestCartesiaTts(text, voiceId, apiKey);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS && !response.ok && isRetryableStatus(response.status); attempt++) {
    console.warn(
      `[podcast-editor] Cartesia TTS attempt ${attempt - 1} failed with ${response.status}, retrying`
    );
    await sleep(RETRY_DELAY_MS);
    response = await requestCartesiaTts(text, voiceId, apiKey);
  }
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    return errorResponse(
      "Server is missing CARTESIA_API_KEY — set it in the environment and restart the server.",
      500
    );
  }

  let body: GenerateSpeechRequestBody;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  const { text, voiceId } = body;
  if (typeof text !== "string" || text.trim().length === 0) {
    return errorResponse("Text is required.", 400);
  }
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    return errorResponse(`Text must be ${MAX_TTS_TEXT_LENGTH} characters or fewer.`, 400);
  }
  if (typeof voiceId !== "string" || !isKnownCartesiaVoiceId(voiceId)) {
    return errorResponse("Unknown voice selected.", 400);
  }

  try {
    const cartesiaResponse = await requestCartesiaTtsWithRetry(text, voiceId, apiKey);

    if (!cartesiaResponse.ok) {
      const detail = await cartesiaResponse.text().catch(() => "");
      console.error("[podcast-editor] Cartesia TTS request failed", cartesiaResponse.status, detail);
      return errorResponse(
        "Speech generation failed — the TTS service returned an error. Please try again.",
        502
      );
    }

    const audioBytes = await cartesiaResponse.arrayBuffer();
    return new Response(audioBytes, {
      status: 200,
      headers: { "Content-Type": "audio/wav" },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return errorResponse("Speech generation timed out. Please try again.", 504);
    }
    console.error("[podcast-editor] Cartesia TTS request threw", err);
    return errorResponse("Speech generation failed unexpectedly. Please try again.", 500);
  }
}
