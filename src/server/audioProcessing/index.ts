import type { AudioProcessingProvider } from "./types";
import { ReplicateAudioProcessingProvider } from "./replicateProvider";

export type {
  AudioProcessingJob,
  AudioProcessingJobStatus,
  AudioProcessingJobStatusResult,
  AudioProcessingProvider,
  AudioProcessingResult,
  CreateNoiseReductionJobInput,
} from "./types";

// Test-only escape hatch — e2e/noiseReductionRoute.spec.ts injects a fake
// in-memory provider here instead of hitting real Replicate, the same way
// e2e/ttsRoute.spec.ts mocks global.fetch for api/tts/route.ts. Not settable
// via any real env var/config path, and never read by application code
// outside this factory. Decouples route-contract tests from Replicate's own
// wire format (still not live-verified as of this writing — see
// replicateProvider.ts's own doc comment) — those tests exercise "does this
// route call the provider correctly and shape its response correctly," which
// doesn't need a real, schema-accurate Replicate response to prove.
let providerOverrideForTesting: AudioProcessingProvider | null = null;

/** Test-only — see this file's own doc comment above. */
export function __setAudioProcessingProviderForTesting(provider: AudioProcessingProvider | null): void {
  providerOverrideForTesting = provider;
}

/**
 * Reads AUDIO_PROCESSING_PROVIDER (default "replicate") and returns the
 * concrete provider instance — the one place that ever imports a concrete
 * provider class. Swapping vendors later (Cleanvoice, a self-hosted
 * DeepFilterNet, ...) means adding one branch here and writing the new
 * class; every route handler imports only this factory, never
 * replicateProvider.ts directly. See NOISE_REDUCTION_PLAN.md.
 */
export function getAudioProcessingProvider(): AudioProcessingProvider {
  if (providerOverrideForTesting) return providerOverrideForTesting;
  const providerName = process.env.AUDIO_PROCESSING_PROVIDER ?? "replicate";
  switch (providerName) {
    case "replicate":
      return new ReplicateAudioProcessingProvider();
    default:
      throw new Error(`Unknown AUDIO_PROCESSING_PROVIDER: "${providerName}"`);
  }
}
