// Energy/RMS-based silence detection + splice. Pure, no React/DOM at module
// scope. See SILENCE_REMOVAL_PLAN.md for the full design.

import { spliceKeepRanges, type ClipSpliceResult, type KeepRange } from "./clipSplice";

export interface SilenceDetectionOptions {
  /** Analysis window length in seconds. Every step below operates in units
   *  of this window, not per-sample (keeps the percentile sort in step 3
   *  cheap on long clips). */
  windowSeconds?: number;
  /** A below-threshold run must span at least this long to count as real
   *  silence. */
  minSilenceSeconds?: number;
  /** Kept on each side of every cut, pulled in from the detected boundary. */
  paddingSeconds?: number;
  /** A kept segment shorter than this after padding is folded into the
   *  surrounding silence instead of kept as a sliver. Matches
   *  @waveform-playlist/engine's own DEFAULT_MIN_DURATION_SECONDS
   *  (engine/dist/index.js:192). */
  minKeptSegmentSeconds?: number;
  /** Noise floor = this percentile (0-1) of the per-window RMS series. */
  noiseFloorPercentile?: number;
  /** Linear multiplier over the noise floor for the actual cutoff.
   *  Default 3 ≈ +9.5dB (20*log10(3) ≈ 9.54). */
  thresholdMultiplier?: number;
}

// ~ -50dBFS (10**(-50/20)). Only used to break the "no relative contrast"
// tie above — a clip whose typical level already sits at/below this is
// close enough to true silence that "no contrast" should mean "this is
// silence", not "leave it alone".
const ABSOLUTE_QUIET_FLOOR = 0.00316;

export const DEFAULT_SILENCE_DETECTION_OPTIONS: Required<SilenceDetectionOptions> = {
  windowSeconds: 0.02,
  minSilenceSeconds: 0.4,
  paddingSeconds: 0.1,
  minKeptSegmentSeconds: 0.1,
  noiseFloorPercentile: 0.1,
  thresholdMultiplier: 3,
};

// KeepRange re-exported for existing importers (transcriptRemap.ts) — its
// canonical home is now clipSplice.ts, shared with filler-word removal.
export type { KeepRange };

function resolveOptions(options?: SilenceDetectionOptions): Required<SilenceDetectionOptions> {
  return { ...DEFAULT_SILENCE_DETECTION_OPTIONS, ...options };
}

/** One RMS value per non-overlapping window, max across channels. */
function computeWindowRms(channelData: Float32Array[], windowSamples: number): Float32Array {
  const totalSamples = channelData[0]?.length ?? 0;
  const windowCount = Math.max(1, Math.ceil(totalSamples / windowSamples));
  const rms = new Float32Array(windowCount);

  for (let w = 0; w < windowCount; w++) {
    const start = w * windowSamples;
    const end = Math.min(start + windowSamples, totalSamples);
    const windowLength = end - start;
    let maxRms = 0;
    for (const channel of channelData) {
      let sumSquares = 0;
      for (let i = start; i < end; i++) {
        sumSquares += channel[i] * channel[i];
      }
      const channelRms = windowLength > 0 ? Math.sqrt(sumSquares / windowLength) : 0;
      if (channelRms > maxRms) maxRms = channelRms;
    }
    rms[w] = maxRms;
  }

  return rms;
}

/** `fraction`-th (0-1) value of `values`, via a sorted copy. Cheap here
 *  since `values` is window-sized, not sample-sized. */
function percentileOf(values: Float32Array, fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

interface WindowRun {
  /** Inclusive window index. */
  startWindow: number;
  /** Exclusive window index. */
  endWindow: number;
}

/** Contiguous runs of windows whose RMS is at or below `threshold`. `<=`,
 *  not `<` — true digital-zero silence (RMS exactly 0) combined with a
 *  noise floor that also computes to exactly 0 would otherwise never match
 *  a strict `<` against its own threshold (0 < 0 is false). */
function findBelowThresholdRuns(rms: Float32Array, threshold: number): WindowRun[] {
  const runs: WindowRun[] = [];
  let runStart: number | null = null;
  for (let w = 0; w < rms.length; w++) {
    const isBelow = rms[w] <= threshold;
    if (isBelow && runStart === null) {
      runStart = w;
    } else if (!isBelow && runStart !== null) {
      runs.push({ startWindow: runStart, endWindow: w });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ startWindow: runStart, endWindow: rms.length });
  return runs;
}

/** Drops kept ranges shorter than `minKeptSamples` — folds them into the
 *  silence around them rather than keeping a near-inaudible sliver. */
function mergeTinyKeptRanges(ranges: KeepRange[], minKeptSamples: number): KeepRange[] {
  return ranges.filter((r) => r.endSample - r.startSample >= minKeptSamples);
}

/**
 * Ascending, non-overlapping ranges to KEEP, in the same sample space as
 * `channelData` (index 0 = the clip's own offsetSamples). A single range
 * spanning the whole input means "no silence detected"; an empty array
 * means "the whole clip is silence" — both are no-op signals for the
 * caller (see spliceOutSilence below), not real edits.
 */
export function detectKeepRanges(
  channelData: Float32Array[],
  sampleRate: number,
  options?: SilenceDetectionOptions
): KeepRange[] {
  const opts = resolveOptions(options);
  const totalSamples = channelData[0]?.length ?? 0;
  if (totalSamples === 0) return [];

  const windowSamples = Math.max(1, Math.round(opts.windowSeconds * sampleRate));
  const rms = computeWindowRms(channelData, windowSamples);

  const noiseFloor = percentileOf(rms, opts.noiseFloorPercentile);
  const threshold = noiseFloor * opts.thresholdMultiplier;

  // If the clip has no real quiet/loud contrast (e.g. a constant-level
  // tone, or true silence too small a fraction of the clip for the
  // percentile to land on it), the threshold can end up at or above the
  // clip's own typical level. A purely relative check can't tell "uniformly
  // loud" (bail out, nothing to remove) apart from "uniformly near-silent"
  // (let it proceed — the whole clip really is silence) — both look like
  // "no contrast" in relative terms. ABSOLUTE_QUIET_FLOOR breaks that tie;
  // the main threshold above stays purely relative/self-calibrating.
  const median = percentileOf(rms, 0.5);
  if (threshold >= median && median >= ABSOLUTE_QUIET_FLOOR) {
    return [{ startSample: 0, endSample: totalSamples }];
  }

  const minSilenceWindows = opts.minSilenceSeconds / opts.windowSeconds;
  const silenceRuns = findBelowThresholdRuns(rms, threshold).filter(
    (run) => run.endWindow - run.startWindow >= minSilenceWindows
  );

  if (silenceRuns.length === 0) {
    return [{ startSample: 0, endSample: totalSamples }];
  }

  // Silence runs -> sample space, padded inward (kept side grows), then
  // inverted into the kept ranges between/around them. A run touching the
  // very start/end of the buffer gets no padding on that side — there's no
  // adjacent kept content there to give a lead-in/lead-out cushion to, so
  // padding there would only manufacture a phantom sliver of "kept" silence
  // (most visible on a fully-silent clip: without this, two padding-sized
  // slivers at the very ends would survive step 6 and this would never read
  // as "no speech found" at all).
  const paddingSamples = Math.round(opts.paddingSeconds * sampleRate);
  const paddedSilence = silenceRuns.map((run) => {
    const rawStart = run.startWindow * windowSamples;
    const rawEnd = Math.min(totalSamples, run.endWindow * windowSamples);
    const start = rawStart === 0 ? 0 : rawStart + paddingSamples;
    const end = rawEnd >= totalSamples ? totalSamples : rawEnd - paddingSamples;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  });

  const keepRanges: KeepRange[] = [];
  let cursor = 0;
  for (const silence of paddedSilence) {
    if (silence.start > cursor) {
      keepRanges.push({ startSample: cursor, endSample: silence.start });
    }
    cursor = Math.max(cursor, silence.end);
  }
  if (cursor < totalSamples) {
    keepRanges.push({ startSample: cursor, endSample: totalSamples });
  }

  const minKeptSamples = Math.round(opts.minKeptSegmentSeconds * sampleRate);
  return mergeTinyKeptRanges(keepRanges, minKeptSamples);
}

// Same shape as clipSplice.ts's ClipSpliceResult, just with silence
// removal's own, more descriptive "all-silence" label in place of the
// generic "removed-all" — see spliceOutSilence's own final line below.
export type SpliceOutSilenceResult = Exclude<ClipSpliceResult, { type: "removed-all" }> | { type: "all-silence" };

/**
 * Detects silence in `sourceBuffer`'s [offsetSamples, offsetSamples +
 * durationSamples) window and splices the kept audio into one new
 * AudioBuffer. Reuses @waveform-playlist/core's concatenateAudioData /
 * createAudioBuffer rather than hand-rolling the same thing.
 */
export function spliceOutSilence(
  audioContext: AudioContext,
  sourceBuffer: AudioBuffer,
  offsetSamples: number,
  durationSamples: number,
  options?: SilenceDetectionOptions
): SpliceOutSilenceResult {
  const channelCount = sourceBuffer.numberOfChannels;
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    channelData.push(sourceBuffer.getChannelData(ch).subarray(offsetSamples, offsetSamples + durationSamples));
  }

  const keepRanges = detectKeepRanges(channelData, sourceBuffer.sampleRate, options);
  const result = spliceKeepRanges(audioContext, sourceBuffer, offsetSamples, durationSamples, keepRanges);
  // "all-silence" is this function's own, more descriptive name for
  // clipSplice.ts's generic "removed-all" outcome — kept as a distinct
  // string here rather than renaming useRemoveSilence.ts's existing check.
  return result.type === "removed-all" ? { type: "all-silence" } : result;
}
