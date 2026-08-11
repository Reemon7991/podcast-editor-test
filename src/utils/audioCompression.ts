// Chunk-first, then Opus-encode each chunk — see
// TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's "Decisions locked in" and
// Phase 0 for why (OpenRouter's 25MB size cap AND ~60s upstream timeout both
// apply; chunking by duration solves both, and a 10-minute chunk is tiny at
// any speech bitrate regardless of the size cap). Opus encoding confirmed
// live against a real Chromium page + a real OpenRouter call in Phase 0 —
// see that section for the exact numbers.

import { AudioBufferSource, BufferTarget, Output, OggOutputFormat } from "mediabunny";
import type { CompressedChunk } from "./types";

export const CHUNK_DURATION_SECONDS = 600; // 10 minutes
const COMPRESSED_SAMPLE_RATE = 16000;
const OPUS_BITRATE = 24000;

export interface TimeChunk {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Pure sample/time math — no Web Audio dependency, Node-testable before ever
 * touching a browser (same order-of-operations discipline
 * silenceDetection.ts's algorithm already established). Splits
 * [0, totalDurationSeconds) into chunkDurationSeconds-sized pieces, the last
 * one possibly shorter; no overlap (this is a duration safeguard against the
 * upstream timeout, not a byte-size workaround, so it doesn't need the
 * overlap-and-dedupe complexity a size-driven chunker would). A clip shorter
 * than chunkDurationSeconds — the overwhelmingly common case — yields exactly
 * one chunk covering the whole thing.
 */
export function splitDurationIntoChunks(
  totalDurationSeconds: number,
  chunkDurationSeconds: number = CHUNK_DURATION_SECONDS
): TimeChunk[] {
  if (totalDurationSeconds <= 0) return [];
  const chunks: TimeChunk[] = [];
  let cursor = 0;
  while (cursor < totalDurationSeconds) {
    const end = Math.min(cursor + chunkDurationSeconds, totalDurationSeconds);
    chunks.push({ startSeconds: cursor, endSeconds: end });
    cursor = end;
  }
  return chunks;
}

/**
 * Downmixes to mono and resamples to 16kHz via OfflineAudioContext — cheap,
 * built into the browser, no library needed for this half. Whisper doesn't
 * benefit from stereo or a higher sample rate; this halves (or more) the
 * bitrate budget for the same transcription quality. Equal-gain sum of every
 * channel, not just the first — a center-panned mono voice split across two
 * channels shouldn't lose half its energy.
 */
export async function downmixAndResample(buffer: AudioBuffer): Promise<AudioBuffer> {
  const frameCount = Math.ceil(buffer.duration * COMPRESSED_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frameCount, COMPRESSED_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  const splitter = offline.createChannelSplitter(buffer.numberOfChannels);
  const gain = offline.createGain();
  gain.gain.value = 1 / buffer.numberOfChannels;
  source.connect(splitter);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) splitter.connect(gain, ch);
  gain.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/** Slices [startSample, endSample) out of a mono buffer into its own
 *  AudioBuffer — AudioBuffer has no built-in slice. `audioContext` is only
 *  used for `createBuffer`, a synchronous allocation with no playback
 *  side effects — safe to reuse the app's single shared real-time context
 *  (`Tone.getContext().rawContext`, same one every other audio util in this
 *  app already takes as a parameter, e.g. silenceDetection.ts's
 *  spliceOutSilence) rather than opening a second one. */
function sliceMonoBuffer(
  audioContext: AudioContext,
  buffer: AudioBuffer,
  startSample: number,
  endSample: number
): AudioBuffer {
  const length = Math.max(0, endSample - startSample);
  const slice = audioContext.createBuffer(1, Math.max(1, length), buffer.sampleRate);
  if (length > 0) {
    slice.copyToChannel(buffer.getChannelData(0).subarray(startSample, endSample), 0);
  }
  return slice;
}

/**
 * Encodes one already-mono/16kHz AudioBuffer to Opus-in-Ogg via mediabunny.
 * Confirmed working end-to-end in TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's
 * Phase 0 spike: encode -> round-trip decodeAudioData (valid, playable) ->
 * send to OpenRouter -> word timestamps still come back correctly. Requires
 * a secure context (`AudioEncoder` is `undefined` otherwise, confirmed in
 * the same spike) — always true for this app, served from localhost in dev
 * or real HTTPS in any deployment.
 */
export async function encodeOpusBlob(monoBuffer: AudioBuffer): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new OggOutputFormat(), target });
  const source = new AudioBufferSource({ codec: "opus", bitrate: OPUS_BITRATE });
  output.addAudioTrack(source);
  await output.start();
  await source.add(monoBuffer);
  await output.finalize();
  // Confirmed non-null: `finalize()` only resolves once the target has been
  // fully written (see mediabunny's own Output.finalize doc comment).
  return new Blob([target.buffer as ArrayBuffer], { type: "audio/ogg" });
}

/**
 * Full pipeline: downmix+resample once (not per-chunk — cheaper, and
 * duration is unaffected by either step so the same time-based chunk
 * boundaries apply to both the original and resampled buffer), chunk by
 * duration, Opus-encode each chunk independently.
 *
 * `startSample`/`endSample` on the returned chunks are in the *original*
 * buffer's sample space (its own native sampleRate) — matching
 * TranscriptWord's own asset-relative coordinate space (utils/types.ts),
 * even though the encoded blob itself is mono/16kHz. Callers needing the
 * chunk's own sample rate for anything else should read it off the blob
 * after decoding, not assume — it's always COMPRESSED_SAMPLE_RATE today but
 * that's an implementation detail of this module, not part of the stored
 * shape.
 */
export async function compressAssetToChunks(
  audioContext: AudioContext,
  buffer: AudioBuffer,
  chunkDurationSeconds: number = CHUNK_DURATION_SECONDS
): Promise<CompressedChunk[]> {
  const mono16k = await downmixAndResample(buffer);
  const timeChunks = splitDurationIntoChunks(buffer.duration, chunkDurationSeconds);
  const chunks: CompressedChunk[] = [];
  for (const { startSeconds, endSeconds } of timeChunks) {
    const startSampleMono = Math.round(startSeconds * COMPRESSED_SAMPLE_RATE);
    const endSampleMono = Math.min(Math.round(endSeconds * COMPRESSED_SAMPLE_RATE), mono16k.length);
    const slice = sliceMonoBuffer(audioContext, mono16k, startSampleMono, endSampleMono);
    const blob = await encodeOpusBlob(slice);
    chunks.push({
      startSample: Math.round(startSeconds * buffer.sampleRate),
      endSample: Math.round(endSeconds * buffer.sampleRate),
      blob,
    });
  }
  return chunks;
}
