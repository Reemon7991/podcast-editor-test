// AudioBuffer -> 16-bit PCM WAV Blob. No standalone encoder is exported by
// @waveform-playlist/browser (its own WAV encoding is internal to the
// export mixdown pipeline, which renders through an OfflineAudioContext —
// the wrong tool here since we already have final PCM in a plain
// AudioBuffer). Same RIFF/WAVE format as e2e/fixtures.ts's
// makeSineWavBuffer, just the encode direction instead of decode-test.

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

export function encodeWavPcm16(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const numFrames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const blockAlign = numChannels * 2; // 16-bit samples
  const dataSize = numFrames * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size (PCM)
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(buffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, Math.round(sample * 32767), true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

/**
 * Reads just enough of a fixed 44-byte-header 16-bit PCM WAV (the format
 * encodeWavPcm16 above always produces, and the format
 * useNoiseReduction.ts's client pipeline always uploads) to compute its
 * duration — no AudioContext/decodeAudioData needed, so this also works
 * server-side (api/noise-reduction/route.ts's own max-duration guard),
 * where no AudioContext exists at all.
 */
export function readWavDurationSeconds(bytes: ArrayBuffer): number {
  const view = new DataView(bytes);
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const dataSize = view.getUint32(40, true);
  const bytesPerSample = 2; // 16-bit PCM, matches encodeWavPcm16 above
  if (numChannels === 0 || sampleRate === 0) return 0;
  return dataSize / bytesPerSample / numChannels / sampleRate;
}
