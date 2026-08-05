import type { ClipMeta } from "./types";

/**
 * Builds a new `ClipMeta` for a decoded `AudioBuffer` already registered in
 * assetRegistry.ts under `assetId`. Extracted out of
 * `useTimelineTracks.ts`'s `addFilesToTrack` loop so the upload path and the
 * TTS-generation path (`useGenerateSpeech.ts`) build a clip the same way
 * instead of duplicating this field list — see TTS_CARTESIA_PLAN.md.
 *
 * `offsetSamples: 0` / `sourceDurationSamples: buffer.length` / `gain: 1`
 * are always the same for a freshly-created clip (no trim/gain applied
 * yet) — only `assetId`/`startSample`/duration (from `buffer`)/`name` vary
 * per call site.
 */
export function buildClipMeta(
  assetId: string,
  buffer: AudioBuffer,
  startSample: number,
  name: string
): ClipMeta {
  return {
    id: crypto.randomUUID(),
    assetId,
    startSample,
    durationSamples: buffer.length,
    offsetSamples: 0,
    sampleRate: buffer.sampleRate,
    sourceDurationSamples: buffer.length,
    gain: 1,
    name,
  };
}
