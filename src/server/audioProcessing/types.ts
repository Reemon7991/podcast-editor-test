// Provider-abstraction contract for server-side audio processing (noise
// reduction today; a future sibling like humming removal would get its own
// `createXJob` method here rather than a generic operation-string dispatch —
// see NOISE_REDUCTION_PLAN.md's "Evaluation of the proposed
// AudioProcessingProvider interface"). Only ever imported from
// src/app/api/noise-reduction/*/route.ts and index.ts's factory — never from
// client code, since a concrete provider (replicateProvider.ts) reads a
// server-only secret.

/** Reuses Replicate's own status vocabulary verbatim — already generic
 *  job-status words, not Replicate-specific, so every provider (including a
 *  genuinely synchronous one, which would just report "succeeded" on the
 *  first poll) can report into this same enum honestly, no translation
 *  layer needed. */
export type AudioProcessingJobStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

export interface AudioProcessingJob {
  id: string;
}

export interface AudioProcessingJobStatusResult {
  status: AudioProcessingJobStatus;
  /** Present only when status is "failed". */
  error?: string;
}

export interface CreateNoiseReductionJobInput {
  /** The clip's played sample range, already sliced and WAV-encoded
   *  client-side (see utils/audioBufferSlice.ts + utils/wavEncode.ts). */
  audio: Blob;
}

export interface AudioProcessingResult {
  /** Raw processed audio bytes, ready to stream straight back to the
   *  browser (mirrors app/api/tts/route.ts's own binary-response shape). */
  audio: ArrayBuffer;
  contentType: string;
}

export interface AudioProcessingProvider {
  createNoiseReductionJob(input: CreateNoiseReductionJobInput): Promise<AudioProcessingJob>;
  getJobStatus(jobId: string): Promise<AudioProcessingJobStatusResult>;
  getResult(jobId: string): Promise<AudioProcessingResult>;
}
