import { getAudioProcessingProvider } from "../../../server/audioProcessing";
import { errorResponse } from "../../../utils/apiResponse";
import { readWavDurationSeconds } from "../../../utils/wavEncode";

/**
 * Creates a noise-reduction job for one clip's audio — see
 * NOISE_REDUCTION_PLAN.md. Modeled directly on api/tts/route.ts: same
 * "missing token -> clean validated 500" precedent for REPLICATE_API_TOKEN
 * that route already established for CARTESIA_API_KEY, same errorResponse
 * shape (now shared, see utils/apiResponse.ts).
 *
 * Accepts multipart/form-data (an "audio" field, the clip's WAV — encoded
 * client-side via utils/wavEncode.ts, same encoder silence removal already
 * uses) rather than JSON, since TTS's request body is a few hundred
 * characters of text but this one is real audio data, sometimes tens of MB.
 */

// Generous for a real podcast clip, bounds cost/time against Replicate's
// resemble-enhance (~70-80s/run on its own, before upload/download) — see
// the plan's "Guards worth including" section.
const MAX_CLIP_DURATION_SECONDS = 30 * 60;

export async function POST(request: Request): Promise<Response> {
  if (!process.env.REPLICATE_API_TOKEN) {
    return errorResponse(
      "Server is missing REPLICATE_API_TOKEN — set it in the environment and restart the server.",
      500
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse("Request body must be multipart/form-data.", 400);
  }

  const audio = formData.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return errorResponse('An "audio" file is required.', 400);
  }

  const arrayBuffer = await audio.arrayBuffer();
  let durationSeconds: number;
  try {
    durationSeconds = readWavDurationSeconds(arrayBuffer);
  } catch {
    return errorResponse("Audio must be a valid WAV file.", 400);
  }
  if (durationSeconds <= 0) {
    return errorResponse("Audio must be a valid WAV file.", 400);
  }
  if (durationSeconds > MAX_CLIP_DURATION_SECONDS) {
    return errorResponse(
      `Clip must be ${MAX_CLIP_DURATION_SECONDS / 60} minutes or shorter for noise reduction.`,
      400
    );
  }

  try {
    const provider = getAudioProcessingProvider();
    const job = await provider.createNoiseReductionJob({
      audio: new Blob([arrayBuffer], { type: "audio/wav" }),
    });
    return Response.json({ jobId: job.id });
  } catch (err) {
    console.error("[podcast-editor] Noise reduction job creation failed", err);
    return errorResponse("Failed to start noise reduction. Please try again.", 502);
  }
}
