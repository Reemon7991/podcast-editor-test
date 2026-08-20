// Downmix + resample + Opus-encode a whole asset in one blob — see
// ASSEMBLYAI_TRANSCRIPTION_REFACTOR_PLAN.md. No chunking: AssemblyAI's
// 5GB/10hr per-request limit comfortably covers this app's target (2-3 hour
// podcasts), unlike the old OpenRouter pipeline's 25MB/~60s constraints.

import { AudioBufferSource, BufferTarget, Output, OggOutputFormat } from "mediabunny";

const COMPRESSED_SAMPLE_RATE = 16000;
const OPUS_BITRATE = 24000;

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

/** Encodes one already-mono/16kHz AudioBuffer to Opus-in-Ogg via mediabunny.
 *  Requires a secure context (`AudioEncoder` is `undefined` otherwise) —
 *  always true for this app (localhost in dev, real HTTPS in deployment). */
export async function encodeOpusBlob(monoBuffer: AudioBuffer): Promise<Blob> {
  const target = new BufferTarget();
  const output = new Output({ format: new OggOutputFormat(), target });
  const source = new AudioBufferSource({ codec: "opus", bitrate: OPUS_BITRATE });
  output.addAudioTrack(source);
  await output.start();
  await source.add(monoBuffer);
  await output.finalize();
  // finalize() only resolves once target has been fully written.
  return new Blob([target.buffer as ArrayBuffer], { type: "audio/ogg" });
}

/** Full pipeline: downmix+resample, then Opus-encode — one blob per asset. */
export async function compressAsset(buffer: AudioBuffer): Promise<Blob> {
  const mono16k = await downmixAndResample(buffer);
  return encodeOpusBlob(mono16k);
}
