// Extracts a clip's played [offsetSamples, offsetSamples + durationSamples)
// range out of its source AudioBuffer. Shared by silenceDetection.ts's own
// RMS scan and useNoiseReduction.ts's clip-audio extraction (see
// NOISE_REDUCTION_PLAN.md) — both need exactly this slice, not the whole
// underlying source buffer (a clip can be trimmed, so offset/duration is a
// sub-range of it).

import { createAudioBuffer } from "@waveform-playlist/core";

/** Per-channel Float32Array views (not copies) of the played range. */
export function sliceChannelData(
  buffer: AudioBuffer,
  offsetSamples: number,
  durationSamples: number
): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    channels.push(buffer.getChannelData(ch).subarray(offsetSamples, offsetSamples + durationSamples));
  }
  return channels;
}

/** Same slice, copied into a standalone new AudioBuffer — for callers that
 *  need a real AudioBuffer to hand off (e.g. wavEncode.ts), not just a view
 *  into the original. channelCount passed explicitly to createAudioBuffer —
 *  it defaults to 1 (mono) when omitted, silently dropping every channel
 *  past the first (see spliceOutSilence's own doc comment on this same
 *  gotcha). */
export function extractClipAudio(
  audioContext: AudioContext,
  buffer: AudioBuffer,
  offsetSamples: number,
  durationSamples: number
): AudioBuffer {
  const channelData = sliceChannelData(buffer, offsetSamples, durationSamples);
  return createAudioBuffer(audioContext, channelData, buffer.sampleRate, buffer.numberOfChannels);
}
