// Background transcription orchestration — see
// TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 3. A plain module, not a
// hook: runTranscriptionPipeline must be callable from both
// useTimelineTracks.ts's addFilesToTrack (an async IIFE) and
// useGenerateSpeech.ts's generateSpeech (a plain async function), neither of
// which wants a second hook's local state. Reads/writes transcriptStore.ts
// via getState()/setState() outside React, same pattern projectStore.ts
// already uses for its own module-level stopIfPlaying.

import { useTranscriptStore } from "../store/transcriptStore";
import { saveTranscript } from "./persistence";
import { settleWithConcurrencyLimit } from "./concurrency";
import type { AssetTranscript, CompressedChunk, TranscriptWord } from "./types";

interface TranscribeChunkResult {
  words: TranscriptWord[];
}

// A long asset can have dozens of chunks (a 3-hour podcast at the default
// 10-min chunk size is 18) — firing every one of them at OpenRouter
// simultaneously is a real way to trigger upstream rate limiting that a
// bounded burst wouldn't. Picked conservatively; easy to tune if real usage
// shows it's too cautious or too aggressive.
const MAX_CONCURRENT_CHUNK_REQUESTS = 3;

async function transcribeChunk(chunk: CompressedChunk, sampleRate: number): Promise<TranscribeChunkResult> {
  const form = new FormData();
  form.append("file", chunk.blob, "chunk.ogg");

  const response = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Transcription request failed (${response.status})`);
  }

  const body = (await response.json()) as { words: { word: string; start: number; end: number }[] };
  // Offset from chunk-relative seconds to asset-relative seconds — this is
  // what makes the merged transcript line up with ClipMeta's own
  // asset-relative offsetSamples/durationSamples regardless of how many
  // chunks the asset was split into.
  const chunkOffsetSeconds = chunk.startSample / sampleRate;
  const words: TranscriptWord[] = body.words.map((w) => ({
    word: w.word,
    start: w.start + chunkOffsetSeconds,
    end: w.end + chunkOffsetSeconds,
  }));
  return { words };
}

/**
 * Fires one transcription request per chunk in parallel, merges the results
 * into one asset-relative word list, and writes the outcome to both
 * transcriptStore (immediate, in-memory) and IndexedDB (persisted, survives
 * a reload). Never throws — every outcome (full success, partial failure,
 * total failure) is represented in the written AssetTranscript instead.
 *
 * `sampleRate` is the *original* asset's sample rate (audioBuffer.sampleRate
 * at the call site) — needed to convert each chunk's startSample (stored in
 * the original asset's sample space, see utils/types.ts's CompressedChunk
 * doc comment) into a seconds offset.
 */
export async function runTranscriptionPipeline(
  assetId: string,
  chunks: CompressedChunk[],
  sampleRate: number
): Promise<void> {
  const { setTranscript } = useTranscriptStore.getState();

  setTranscript({ assetId, status: "transcribing", words: null, updatedAt: Date.now() });

  const settled = await settleWithConcurrencyLimit(chunks, MAX_CONCURRENT_CHUNK_REQUESTS, (chunk) =>
    transcribeChunk(chunk, sampleRate)
  );

  const succeeded = settled.filter(
    (r): r is PromiseFulfilledResult<TranscribeChunkResult> => r.status === "fulfilled"
  );
  const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");

  let transcript: AssetTranscript;
  if (succeeded.length === 0) {
    const firstError = failed[0]?.reason;
    transcript = {
      assetId,
      status: "failed",
      words: null,
      error: firstError instanceof Error ? firstError.message : "Transcription failed.",
      updatedAt: Date.now(),
    };
  } else {
    const words = succeeded
      .flatMap((r) => r.value.words)
      .sort((a, b) => a.start - b.start);
    transcript = {
      assetId,
      status: "done",
      words,
      updatedAt: Date.now(),
      ...(failed.length > 0
        ? {
            partialFailure: true,
            error: `${failed.length} of ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} failed to transcribe — some words may be missing.`,
          }
        : {}),
    };
  }

  setTranscript(transcript);
  // Persist failure is logged and swallowed, not thrown — same non-fatal
  // treatment every other persistence write in this app already gets (see
  // useTimelineTracks.ts's addFilesToTrack, useRemoveSilence.ts): the
  // transcript still works for this session via transcriptStore, it just
  // won't survive a reload.
  saveTranscript(transcript).catch((err) => {
    console.error("[podcast-editor] Failed to persist transcript to IndexedDB", err);
  });
}
