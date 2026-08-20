import type { AudioClip, ClipTrack } from "@waveform-playlist/browser";

/**
 * Persistence/undo-safe clip shape — everything AudioClip has except the
 * decoded `audioBuffer` (large, session-scoped, never cloned/serialized),
 * replaced by `assetId`: a lookup key into ./assetRegistry.ts. See
 * PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Core mechanism" section.
 *
 * AudioClip also has an optional `waveformData` field for a peaks-first
 * rendering flow this app doesn't use — nothing here ever sets it, so
 * there's nothing to strip from this type.
 */
export type ClipMeta = Omit<AudioClip, "audioBuffer"> & { assetId: string };

export type TrackMeta = Omit<ClipTrack, "clips"> & { clips: ClipMeta[] };

/**
 * One word from a Whisper transcript — seconds are relative to the
 * *original asset's own start* (0 = start of the uploaded/generated file),
 * never to a clip or the project timeline. See
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's "Context" section for why this
 * is the one thing that makes a transcript survive move/trim/split for free
 * via ClipMeta's existing assetId/offsetSamples/durationSamples/startSample
 * fields.
 */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export type TranscriptStatus = "pending" | "transcribing" | "done" | "failed";

/** One per assetId, keyed by assetId in both transcriptStore.ts (in-memory)
 *  and the `transcripts` IndexedDB store (persisted) — see persistence.ts. */
export interface AssetTranscript {
  assetId: string;
  status: TranscriptStatus;
  /** null until status is "done". */
  words: TranscriptWord[] | null;
  /** Legacy field from the old per-chunk pipeline. Unused post-AssemblyAI
   *  refactor — kept optional so old persisted records still typecheck. */
  partialFailure?: boolean;
  error?: string;
  updatedAt: number;
  /** AssemblyAI's transcript id for the in-flight/most recent job on this
   *  asset. Lets a reload resume polling instead of resubmitting — see
   *  ASSEMBLYAI_TRANSCRIPTION_REFACTOR_PLAN.md. */
  providerJobId?: string;
}
