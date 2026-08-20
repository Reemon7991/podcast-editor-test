/**
 * Backend-owned AssemblyAI transcription — poll half. See
 * ASSEMBLYAI_TRANSCRIPTION_REFACTOR_PLAN.md. Proxies AssemblyAI's status
 * endpoint, converts word timestamps ms->s, maps queued/processing->
 * "transcribing", completed->"done", error->"failed".
 *
 * `params` is a Promise in this project's Next.js version — must be awaited,
 * not destructured directly (see AGENTS.md).
 */

const ASSEMBLYAI_TRANSCRIPT_URL = "https://api.assemblyai.com/v2/transcript";
const POLL_TIMEOUT_MS = 15_000;

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

interface AssemblyAiWord {
  text: string;
  start: number;
  end: number;
}

interface AssemblyAiTranscriptResponse {
  status: "queued" | "processing" | "completed" | "error";
  words?: AssemblyAiWord[] | null;
  error?: string;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey) {
    return errorResponse(
      "Server is missing ASSEMBLYAI_API_KEY — set it in the environment and restart the server.",
      500
    );
  }

  const { id } = await params;
  if (!id) return errorResponse("A transcript id is required.", 400);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
  try {
    const response = await fetch(`${ASSEMBLYAI_TRANSCRIPT_URL}/${encodeURIComponent(id)}`, {
      headers: { authorization: apiKey },
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[podcast-editor] AssemblyAI status check failed", response.status, detail);
      return errorResponse("Transcription status check failed.", 502);
    }

    const body = (await response.json()) as AssemblyAiTranscriptResponse;

    if (body.status === "error") {
      return Response.json({ status: "failed", words: null, error: body.error ?? "Transcription failed." });
    }
    if (body.status !== "completed") {
      return Response.json({ status: "transcribing", words: null });
    }
    if (!Array.isArray(body.words)) {
      console.error("[podcast-editor] AssemblyAI completed transcript had no words", body);
      return Response.json({
        status: "failed",
        words: null,
        error: "Transcription completed but returned no word-level timestamps.",
      });
    }

    const words = body.words.map((w) => ({ word: w.text, start: w.start / 1000, end: w.end / 1000 }));
    return Response.json({ status: "done", words });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return errorResponse("Transcription status check timed out.", 504);
    }
    console.error("[podcast-editor] AssemblyAI status check threw", err);
    return errorResponse("Transcription status check failed unexpectedly.", 500);
  } finally {
    clearTimeout(timeout);
  }
}
