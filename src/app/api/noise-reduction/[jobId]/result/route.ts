import { getAudioProcessingProvider } from "../../../../../server/audioProcessing";
import { errorResponse } from "../../../../../utils/apiResponse";

/**
 * Streams the finished, denoised WAV back to the browser once a job has
 * succeeded — see NOISE_REDUCTION_PLAN.md. Mirrors api/tts/route.ts's own
 * binary-response pattern so the browser only ever talks to this app's own
 * origin, never a replicate.delivery URL directly.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<Response> {
  if (!process.env.REPLICATE_API_TOKEN) {
    return errorResponse(
      "Server is missing REPLICATE_API_TOKEN — set it in the environment and restart the server.",
      500
    );
  }

  const { jobId } = await params;

  try {
    const provider = getAudioProcessingProvider();
    const result = await provider.getResult(jobId);
    return new Response(result.audio, {
      status: 200,
      headers: { "Content-Type": result.contentType },
    });
  } catch (err) {
    console.error("[podcast-editor] Noise reduction result fetch failed", err);
    return errorResponse("Failed to fetch noise reduction result.", 502);
  }
}
