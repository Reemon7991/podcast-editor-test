/**
 * Backend-owned Whisper transcription (via OpenRouter) — see
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 3 for the full design.
 * Mirrors api/tts/route.ts's shape exactly: this route holds the
 * server-only API key, forwards one already-compressed audio chunk to
 * OpenRouter, and returns the word-level timestamps straight through. The
 * client (utils/transcription.ts) owns fan-out across an asset's chunks and
 * merging the results — this route only ever sees one chunk per request,
 * same "server is a thin per-request proxy" precedent /api/tts already sets.
 *
 * Request/response shape and the `word` (not `text`) field name were
 * confirmed against a real OpenRouter call in Phase 0's spike, not assumed
 * from docs — see that section for the exact numbers.
 */

const OPENROUTER_TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
const WHISPER_MODEL = "openai/whisper-large-v3";
const TRANSCRIBE_TIMEOUT_MS = 45_000;

// Same retry policy as api/tts/route.ts's requestCartesiaTtsWithRetry: one
// retry, only for a transient *upstream* problem (429/5xx) — a 4xx here
// (bad file, unsupported format) is a deterministic client-input problem
// that retrying would only delay, not fix.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

interface OpenRouterWord {
  word: string;
  start: number;
  end: number;
}

interface OpenRouterTranscriptionResponse {
  text?: string;
  words?: OpenRouterWord[];
}

/** One attempt against OpenRouter, with its own AbortController/timeout —
 *  same reasoning as api/tts/route.ts's requestCartesiaTts: a retried second
 *  attempt gets a fresh timeout budget, not one shared across both. */
async function requestTranscription(file: Blob, filename: string, apiKey: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", file, filename);
    form.append("model", WHISPER_MODEL);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");

    return await fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTranscriptionWithRetry(file: Blob, filename: string, apiKey: string): Promise<Response> {
  let response = await requestTranscription(file, filename, apiKey);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS && !response.ok && isRetryableStatus(response.status); attempt++) {
    console.warn(
      `[podcast-editor] OpenRouter transcription attempt ${attempt - 1} failed with ${response.status}, retrying`
    );
    await sleep(RETRY_DELAY_MS);
    response = await requestTranscription(file, filename, apiKey);
  }
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return errorResponse(
      "Server is missing OPENROUTER_API_KEY — set it in the environment and restart the server.",
      500
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("Request body must be multipart/form-data.", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof Blob) || file.size === 0) {
    return errorResponse("A non-empty audio file is required.", 400);
  }

  try {
    const openRouterResponse = await requestTranscriptionWithRetry(file, "chunk.ogg", apiKey);

    if (!openRouterResponse.ok) {
      const detail = await openRouterResponse.text().catch(() => "");
      console.error("[podcast-editor] OpenRouter transcription request failed", openRouterResponse.status, detail);
      return errorResponse(
        "Transcription failed — the speech-to-text service returned an error.",
        502
      );
    }

    const result = (await openRouterResponse.json()) as OpenRouterTranscriptionResponse;
    // Some providers OpenRouter can route this model to don't honor
    // timestamp_granularities (confirmed possible per OpenRouter's own docs,
    // see the plan) — treat a missing/non-array `words` as a clean failure
    // rather than silently returning an empty transcript that would read as
    // "no speech found."
    if (!Array.isArray(result.words)) {
      console.error("[podcast-editor] OpenRouter transcription response had no word-level timestamps", result);
      return errorResponse(
        "Transcription succeeded but returned no word-level timestamps.",
        502
      );
    }

    return Response.json({ words: result.words });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return errorResponse("Transcription timed out. Please try again.", 504);
    }
    console.error("[podcast-editor] OpenRouter transcription request threw", err);
    return errorResponse("Transcription failed unexpectedly.", 500);
  }
}
