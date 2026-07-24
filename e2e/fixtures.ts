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
