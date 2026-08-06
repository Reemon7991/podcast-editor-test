/**
 * Synthetic audio for upload tests — a raw PCM sine wave wrapped in a minimal
 * 44-byte RIFF/WAV header, generated in-memory (no fixture files on disk, no
 * dependency on real audio assets). Ported from this project's prior ad-hoc
 * Playwright scripts (see PERSISTENCE_UNDO_ORIGINAL_PLAN.md, Phase 0) into a
 * shared helper so every spec can build exactly the file it needs.
 */

interface SineWavOptions {
  sampleRate?: number;
  frequency?: number;
}

export function makeSineWavBuffer(
  durationSeconds: number,
  { sampleRate = 44100, frequency = 440 }: SineWavOptions = {}
): Buffer {
  const numSamples = Math.floor(durationSeconds * sampleRate);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.5;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buffer;
}

export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** Ready to hand directly to Locator.setInputFiles(). */
export function makeSineWavFile(
  name: string,
  durationSeconds: number,
  options?: SineWavOptions
): UploadFile {
  return {
    name,
    mimeType: "audio/wav",
    buffer: makeSineWavBuffer(durationSeconds, options),
  };
}

export interface WavSegment {
  kind: "tone" | "silence";
  seconds: number;
}

/**
 * A WAV built from alternating tone/silence segments, for
 * silenceRemoval.spec.ts — a tone/silence/tone/silence/tone shape with known
 * gap positions, rather than depending on real audio. "silence" segments are
 * dithered low-level noise (±0.001), not literal digital zero — matters for
 * silenceDetection.ts's threshold math: real recorded silence is never
 * exactly 0, and (found via actual manual verification against this app, not
 * just reasoned about) a threshold computed from true digital-zero silence
 * can, depending on the exact comparison used, never classify anything as
 * "below" it. Dithering here keeps this fixture representative of that.
 */
export function makeSegmentedWavBuffer(
  segments: WavSegment[],
  { sampleRate = 44100, frequency = 440 }: SineWavOptions = {}
): Buffer {
  const totalSamples = segments.reduce((sum, s) => sum + Math.floor(s.seconds * sampleRate), 0);
  const dataSize = totalSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  let tGlobal = 0;
  for (const segment of segments) {
    const n = Math.floor(segment.seconds * sampleRate);
    for (let i = 0; i < n; i++) {
      const t = tGlobal / sampleRate;
      const sample =
        segment.kind === "tone"
          ? Math.sin(2 * Math.PI * frequency * t) * 0.5
          : (Math.random() - 0.5) * 0.002;
      buffer.writeInt16LE(Math.round(sample * 32767), offset);
      offset += 2;
      tGlobal++;
    }
  }

  return buffer;
}

export function makeSegmentedWavFile(
  name: string,
  segments: WavSegment[],
  options?: SineWavOptions
): UploadFile {
  return {
    name,
    mimeType: "audio/wav",
    buffer: makeSegmentedWavBuffer(segments, options),
  };
}

export interface StereoSineWavOptions extends SineWavOptions {
  leftAmplitude?: number;
  rightAmplitude?: number;
}

/**
 * A 2-channel version of makeSegmentedWavBuffer — left/right carry the same
 * tone/silence timing (so there's one shared gap to remove) but different
 * amplitudes, so a downstream mutation that accidentally collapsed the
 * result to mono (e.g. silenceDetection.ts's spliceOutSilence passing the
 * wrong channelCount to createAudioBuffer — a real bug found and fixed
 * while building this feature, see SILENCE_REMOVAL_PLAN.md) is
 * observable: the two channels would no longer differ.
 */
export function makeStereoSegmentedWavBuffer(
  segments: WavSegment[],
  { sampleRate = 44100, frequency = 440, leftAmplitude = 0.5, rightAmplitude = 0.2 }: StereoSineWavOptions = {}
): Buffer {
  const numChannels = 2;
  const totalSamples = segments.reduce((sum, s) => sum + Math.floor(s.seconds * sampleRate), 0);
  const dataSize = totalSamples * 2 * numChannels; // 16-bit stereo, interleaved
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2 * numChannels, 28);
  buffer.writeUInt16LE(2 * numChannels, 32); // block align
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  let tGlobal = 0;
  for (const segment of segments) {
    const n = Math.floor(segment.seconds * sampleRate);
    for (let i = 0; i < n; i++) {
      const t = tGlobal / sampleRate;
      const carrier = Math.sin(2 * Math.PI * frequency * t);
      const noise = () => (Math.random() - 0.5) * 0.002;
      const left = segment.kind === "tone" ? carrier * leftAmplitude : noise();
      const right = segment.kind === "tone" ? carrier * rightAmplitude : noise();
      buffer.writeInt16LE(Math.round(left * 32767), offset);
      offset += 2;
      buffer.writeInt16LE(Math.round(right * 32767), offset);
      offset += 2;
      tGlobal++;
    }
  }

  return buffer;
}

export function makeStereoSegmentedWavFile(
  name: string,
  segments: WavSegment[],
  options?: StereoSineWavOptions
): UploadFile {
  return {
    name,
    mimeType: "audio/wav",
    buffer: makeStereoSegmentedWavBuffer(segments, options),
  };
}
