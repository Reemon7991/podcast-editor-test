// Compressed export formats — MP3/AAC alternatives to the existing WAV
// export. Reuses the exact mediabunny pattern already proven live in
// audioCompression.ts's Opus encoder (AudioBufferSource -> Output ->
// BufferTarget), just pointed at export-quality stereo codecs/bitrates
// instead of that file's mono/16kHz/24kbps speech-to-text constants — the
// two are unrelated and neither should be tuned by touching the other.
//
// Opus/FLAC were considered and deliberately deferred (see CLAUDE.md's
// Export section) — MP3 + AAC only for this first pass.

import {
  AudioBufferSource,
  BufferTarget,
  Output,
  Mp3OutputFormat,
  Mp4OutputFormat,
  canEncodeAudio,
  type OutputFormat,
} from "mediabunny";

export type ExportFormat = "wav" | "mp3-64" | "mp3-128" | "mp3-160" | "aac-128";

/** Menu/download order — WAV first (today's existing default), compressed
 *  options after it. */
export const EXPORT_FORMAT_ORDER: ExportFormat[] = [
  "wav",
  "mp3-64",
  "mp3-128",
  "mp3-160",
  "aac-128",
];

interface CompressedFormatSpec {
  codec: "mp3" | "aac";
  bitrate: number; // bits per second
  extension: string;
  mimeType: string;
  label: string;
  createOutputFormat: () => OutputFormat;
}

const COMPRESSED_FORMATS: Record<Exclude<ExportFormat, "wav">, CompressedFormatSpec> = {
  "mp3-64": {
    codec: "mp3",
    bitrate: 64_000,
    extension: "mp3",
    mimeType: "audio/mpeg",
    label: "MP3 · 64 kbps",
    createOutputFormat: () => new Mp3OutputFormat(),
  },
  "mp3-128": {
    codec: "mp3",
    bitrate: 128_000,
    extension: "mp3",
    mimeType: "audio/mpeg",
    label: "MP3 · 128 kbps",
    createOutputFormat: () => new Mp3OutputFormat(),
  },
  "mp3-160": {
    codec: "mp3",
    bitrate: 160_000,
    extension: "mp3",
    mimeType: "audio/mpeg",
    label: "MP3 · 160 kbps",
    createOutputFormat: () => new Mp3OutputFormat(),
  },
  "aac-128": {
    codec: "aac",
    bitrate: 128_000,
    extension: "m4a",
    mimeType: "audio/mp4",
    label: "AAC · 128 kbps",
    createOutputFormat: () => new Mp4OutputFormat(),
  },
};

export function exportFormatLabel(format: ExportFormat): string {
  return format === "wav" ? "WAV (lossless)" : COMPRESSED_FORMATS[format].label;
}

/** File extension for a compressed format's downloaded file — WAV isn't
 *  covered here since that path downloads via the library's own
 *  autoDownload, which already appends ".wav" itself. */
export function exportFileExtension(format: Exclude<ExportFormat, "wav">): string {
  return COMPRESSED_FORMATS[format].extension;
}

/**
 * Feature-detects whether this browser's WebCodecs AudioEncoder can produce
 * the given format. WAV never needs an encoder, so it's always true.
 *
 * MP3 in particular isn't guaranteed the way AAC is — confirmed live (see
 * ensureMp3EncoderReady below) — so callers should await
 * ensureMp3EncoderReady() once before relying on this for "mp3-*", or this
 * will correctly (but needlessly) report unsupported on a browser that only
 * lacks the *native* encoder.
 */
export async function canEncodeFormat(format: ExportFormat): Promise<boolean> {
  if (format === "wav") return true;
  const spec = COMPRESSED_FORMATS[format];
  return canEncodeAudio(spec.codec, { numberOfChannels: 2, bitrate: spec.bitrate });
}

let mp3EncoderReadyPromise: Promise<void> | null = null;

/**
 * Makes MP3 encoding available in this browser, no matter what. Checks for
 * native WebCodecs support first (free, no extra download); only when that's
 * missing does it dynamically import @mediabunny/mp3-encoder — an official
 * mediabunny extension, confirmed peer-compatible with this project's
 * installed mediabunny version — and register its WASM/LAME polyfill.
 *
 * Nothing else needs to change once this resolves: mediabunny's own
 * canEncodeAudio checks registered custom encoders *before* the native
 * check (confirmed by reading encode.js directly), so canEncodeFormat("mp3-
 * *") and encodeCompressed() start working unmodified.
 *
 * Module-level cached promise — registerMp3Encoder() must only run once per
 * page load no matter how many times this is called (useExportFormatSupport
 * mounting more than once, Strict Mode, a future second caller). On failure
 * (e.g. a transient network blip loading the dynamic import's chunk, or the
 * Worker failing to spawn), the cache is cleared before rejecting so a later
 * call — a user simply retrying the export — gets a fresh attempt instead of
 * replaying the same dead rejected promise for the rest of the page session.
 */
export function ensureMp3EncoderReady(): Promise<void> {
  if (!mp3EncoderReadyPromise) {
    mp3EncoderReadyPromise = (async () => {
      const nativelySupported = await canEncodeAudio("mp3", {
        numberOfChannels: 2,
        bitrate: 128_000,
      });
      if (!nativelySupported) {
        const { registerMp3Encoder } = await import("@mediabunny/mp3-encoder");
        registerMp3Encoder();
      }
    })().catch((err) => {
      mp3EncoderReadyPromise = null;
      throw err;
    });
  }
  return mp3EncoderReadyPromise;
}

/**
 * Encodes an already-rendered mixdown buffer to MP3/AAC. Takes the same
 * `AudioBuffer` WAV export already produces (`ExportResult.audioBuffer`) —
 * the mixdown/fades/solo-mute rendering is entirely shared with WAV; only
 * this final container/codec step differs.
 */
export async function encodeCompressed(
  buffer: AudioBuffer,
  format: Exclude<ExportFormat, "wav">
): Promise<Blob> {
  const spec = COMPRESSED_FORMATS[format];
  const target = new BufferTarget();
  const output = new Output({ format: spec.createOutputFormat(), target });
  const source = new AudioBufferSource({ codec: spec.codec, bitrate: spec.bitrate });
  output.addAudioTrack(source);
  await output.start();
  await source.add(buffer);
  await output.finalize();
  return new Blob([target.buffer as ArrayBuffer], { type: spec.mimeType });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
