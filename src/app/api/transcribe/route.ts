/**
 * Backend-owned AssemblyAI transcription — submit half. See
 * ASSEMBLYAI_TRANSCRIPTION_REFACTOR_PLAN.md. Uploads the client's compressed
 * chunk to AssemblyAI, submits a transcript job, returns the job id
 * immediately (no polling here — see app/api/transcribe/[id]/route.ts).
 */

const ASSEMBLYAI_UPLOAD_URL = "https://api.assemblyai.com/v2/upload";
const ASSEMBLYAI_TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";
const SPEECH_MODELS = ["universal-3-5-pro"];
const VERBATIM_PROMPT =
  "Transcribe verbatim. Include spoken filler words, hesitations, plus repetitions and false starts when clearly spoken.";

// Same retry policy as api/tts/route.ts: one retry, only for a transient
// upstream problem (429/5xx) — a 4xx is a deterministic client-input problem
// retrying wouldn't fix.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const UPLOAD_TIMEOUT_MS = 60_000;
const SUBMIT_TIMEOUT_MS = 15_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let response = await requestWithTimeout(url, init, timeoutMs);
  for (let attempt = 2; attempt <= MAX_ATTEMPTS && !response.ok && isRetryableStatus(response.status); attempt++) {
    console.warn(`[podcast-editor] AssemblyAI request to ${url} attempt ${attempt - 1} failed with ${response.status}, retrying`);
    await sleep(RETRY_DELAY_MS);
    response = await requestWithTimeout(url, init, timeoutMs);
  }
  return response;
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return errorResponse(
      "Server is missing ASSEMBLYAI_API_KEY — set it in the environment and restart the server.",
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
    const uploadResponse = await requestWithRetry(
      ASSEMBLYAI_UPLOAD_URL,
      {
        method: "POST",
        headers: { authorization: apiKey, "Content-Type": "application/octet-stream" },
        body: file,
      },
      UPLOAD_TIMEOUT_MS
    );
    if (!uploadResponse.ok) {
      const detail = await uploadResponse.text().catch(() => "");
      console.error("[podcast-editor] AssemblyAI upload failed", uploadResponse.status, detail);
      return errorResponse("Transcription failed — could not upload audio.", 502);
    }
    const { upload_url: audioUrl } = (await uploadResponse.json()) as { upload_url?: string };
    if (!audioUrl) {
      console.error("[podcast-editor] AssemblyAI upload response had no upload_url");
      return errorResponse("Transcription failed — could not upload audio.", 502);
    }

    const submitResponse = await requestWithRetry(
      ASSEMBLYAI_TRANSCRIPT_URL,
      {
        method: "POST",
        headers: { authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_url: audioUrl,
          speech_models: SPEECH_MODELS,
          disfluencies: true,
          language_detection: true,
          prompt: VERBATIM_PROMPT,
        }),
      },
      SUBMIT_TIMEOUT_MS
    );
    if (!submitResponse.ok) {
      const detail = await submitResponse.text().catch(() => "");
      console.error("[podcast-editor] AssemblyAI submit failed", submitResponse.status, detail);
      return errorResponse("Transcription failed — the speech-to-text service returned an error.", 502);
    }
    const { id } = (await submitResponse.json()) as { id?: string };
    if (!id) {
      console.error("[podcast-editor] AssemblyAI submit response had no id");
      return errorResponse("Transcription failed — no job id returned.", 502);
    }

    return Response.json({ transcriptId: id });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return errorResponse("Transcription request timed out. Please try again.", 504);
    }
    console.error("[podcast-editor] AssemblyAI request threw", err);
    return errorResponse("Transcription failed unexpectedly.", 500);
  }
}
