// Shared "splice a clip down to just these keep ranges" step — the common
// tail of both silence removal (silenceDetection.ts) and filler-word removal
// (fillerWordDetection.ts). Both features are mechanically identical from
// here on: detect ranges to remove -> invert to keepRanges -> splice; only
// the detector differs (RMS threshold vs. transcript filler-word matches).
// Extracted out of silenceDetection.ts so that splice step — and the
// explicit-channelCount bug fix it carries (see below) — isn't duplicated.
// See TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 6.

import { concatenateAudioData, createAudioBuffer } from "@waveform-playlist/core";

export interface KeepRange {
  /** Sample offset relative to the analyzed audio's own start (0 = the
   *  clip's offsetSamples), not the timeline. */
  startSample: number;
  /** Exclusive end, same coordinate space as startSample. */
  endSample: number;
}

export type ClipSpliceResult =
  | { type: "unchanged" }
  /** Every sample in [offsetSamples, offsetSamples+durationSamples) was
   *  removed — nothing left to splice. */
  | { type: "removed-all" }
  | {
      type: "trimmed";
      buffer: AudioBuffer;
      leadingEdgeKept: boolean;
      trailingEdgeKept: boolean;
      /** Echoed back for callers that need to remap a transcript through the
       *  same cuts (utils/transcriptRemap.ts) without re-deriving them. */
      keepRanges: KeepRange[];
    };

/**
 * Splices `sourceBuffer`'s [offsetSamples, offsetSamples+durationSamples)
 * window down to just `keepRanges` (ascending, non-overlapping, clip-relative
 * sample offsets) into one new AudioBuffer. Reuses
 * @waveform-playlist/core's concatenateAudioData/createAudioBuffer rather
 * than hand-rolling the same thing.
 */
export function spliceKeepRanges(
  audioContext: AudioContext,
  sourceBuffer: AudioBuffer,
  offsetSamples: number,
  durationSamples: number,
  keepRanges: KeepRange[]
): ClipSpliceResult {
  if (keepRanges.length === 1 && keepRanges[0].startSample === 0 && keepRanges[0].endSample === durationSamples) {
    return { type: "unchanged" };
  }
  if (keepRanges.length === 0) {
    return { type: "removed-all" };
  }

  const channelCount = sourceBuffer.numberOfChannels;
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    channelData.push(sourceBuffer.getChannelData(ch).subarray(offsetSamples, offsetSamples + durationSamples));
  }

  const splicedChannels = channelData.map((channel) =>
    concatenateAudioData(keepRanges.map((range) => channel.slice(range.startSample, range.endSample)))
  );
  // channelCount passed explicitly — createAudioBuffer defaults it to 1
  // (mono) when omitted, which would silently drop every channel past 0 (see
  // CLAUDE.md's "Silence removal" section, bug 7 — this fix now applies to
  // both features automatically since they share this one call site).
  const buffer = createAudioBuffer(audioContext, splicedChannels, sourceBuffer.sampleRate, channelCount);

  return {
    type: "trimmed",
    buffer,
    leadingEdgeKept: keepRanges[0].startSample === 0,
    trailingEdgeKept: keepRanges[keepRanges.length - 1].endSample === durationSamples,
    keepRanges,
  };
}
