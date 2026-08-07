// The only AudioProcessingProvider implementation for v1 — see
// NOISE_REDUCTION_PLAN.md. Never imported anywhere outside index.ts's
// factory, so swapping vendors later can't drag this (or REPLICATE_API_TOKEN)
// along with it.

import Replicate from "replicate";
import type {
  AudioProcessingJob,
  AudioProcessingJobStatusResult,
  AudioProcessingProvider,
  AudioProcessingResult,
  CreateNoiseReductionJobInput,
} from "./types";

// Schema confirmed from the actual Cog source, not a secondary summary (see
// the plan's "Model" section):
// github.com/lucataco/cog-resemble-enhance/predict.py —
//   predict(input_audio: Path, solver="Midpoint", number_function_evaluations=64,
//           prior_temperature=0.5, denoise_flag=False) -> List[Path]
// always returns [output-denoised.wav, output-enhanced.wav] in that order,
// regardless of denoise_flag (both stages always run; the flag only gates
// whether denoising happens *before* enhancement). We always read index 0
// (denoised) — the enhanced file does extra generative bandwidth-extension
// on top, more than "reduce background noise" asked for and a risk to the
// speaker's voice characteristics.
//
// NOT YET LIVE-VERIFIED: the plan's own "Verification" section calls for
// resolving resemble-ai/resemble-enhance vs. lucataco/resemble-enhance by
// fetching both models' live openapi_schema before shipping — not done here
// (no REPLICATE_API_TOKEN was available at implementation time). Defaults to
// the lucataco listing (schema confirmed from source above); override via
// REPLICATE_NOISE_REDUCTION_MODEL if the official resemble-ai listing turns
// out to match once that spike runs.
const DEFAULT_MODEL = "lucataco/resemble-enhance";
const DENOISED_OUTPUT_INDEX = 0;

function client(): Replicate {
  return new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
    // Always upload via the Files API, never silently fall back to a data
    // URI (the SDK's own "default" strategy would, on a failed upload) —
    // Replicate rejects data URIs over 256KB, and a real podcast clip's WAV
    // almost always exceeds that (see the plan's "File delivery" section).
    // Better to fail loudly than to silently send a request that's likely
    // to be rejected anyway.
    fileEncodingStrategy: "upload",
  });
}

/** Replicate's own Status type includes "aborted" (a user- or
 *  timeout-cancelled run) alongside the five this app's
 *  AudioProcessingJobStatus models — a detail the plan's "reuse Replicate's
 *  status vocabulary verbatim" note didn't account for. Folded into "failed"
 *  here rather than widening the shared interface for one provider-specific
 *  extra state every other provider would have to also invent an opinion
 *  about. */
function normalizeStatus(status: string): AudioProcessingJobStatusResult["status"] {
  return status === "aborted" ? "failed" : (status as AudioProcessingJobStatusResult["status"]);
}

export class ReplicateAudioProcessingProvider implements AudioProcessingProvider {
  async createNoiseReductionJob(input: CreateNoiseReductionJobInput): Promise<AudioProcessingJob> {
    const model = process.env.REPLICATE_NOISE_REDUCTION_MODEL ?? DEFAULT_MODEL;
    const prediction = await client().predictions.create({
      model,
      input: {
        // A Blob input value is auto-uploaded via Replicate's Files API and
        // substituted with the resulting URL before the request is sent
        // (confirmed by reading replicate/lib/util.js's transformFileInputs
        // directly) — no hand-rolled POST /v1/files call needed here.
        input_audio: input.audio,
        denoise_flag: true,
      },
    });
    return { id: prediction.id };
  }

  async getJobStatus(jobId: string): Promise<AudioProcessingJobStatusResult> {
    const prediction = await client().predictions.get(jobId);
    const status = normalizeStatus(prediction.status);
    return {
      status,
      error: status === "failed" && prediction.error ? String(prediction.error) : undefined,
    };
  }

  async getResult(jobId: string): Promise<AudioProcessingResult> {
    const prediction = await client().predictions.get(jobId);
    if (prediction.status !== "succeeded") {
      throw new Error(`Prediction ${jobId} has not succeeded (status: ${prediction.status})`);
    }
    const output = prediction.output as string[] | undefined;
    const denoisedUrl = output?.[DENOISED_OUTPUT_INDEX];
    if (!denoisedUrl) {
      throw new Error(`Prediction ${jobId} succeeded but returned no denoised output`);
    }
    const response = await fetch(denoisedUrl);
    if (!response.ok) {
      throw new Error(`Failed to download denoised result (${response.status})`);
    }
    return { audio: await response.arrayBuffer(), contentType: "audio/wav" };
  }
}
