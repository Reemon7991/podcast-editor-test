import { getAudioProcessingProvider } from "../../../../server/audioProcessing";
import { errorResponse } from "../../../../utils/apiResponse";

/**
 * Polled by useNoiseReduction.ts every ~3s while a job is in flight — see
 * NOISE_REDUCTION_PLAN.md. `params` is a Promise here (this app's bleeding-
 * edge Next.js version, see AGENTS.md — confirmed against
 * node_modules/next/dist/docs' own Route Handlers guide).
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
    const result = await provider.getJobStatus(jobId);
    return Response.json(result);
  } catch (err) {
    console.error("[podcast-editor] Noise reduction status check failed", err);
    return errorResponse("Failed to check noise reduction status.", 502);
  }
}
