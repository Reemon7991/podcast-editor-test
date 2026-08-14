import { create } from "zustand";
import type { AssetTranscript } from "../utils/types";

/**
 * assetId -> AssetTranscript, in-memory only (persisted separately via
 * utils/persistence.ts's `transcripts` store; useProjectHydration.ts
 * repopulates this on reload). See TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's
 * Phase 1.
 *
 * Deliberately a *separate* store from projectStore.ts, and never read by
 * anything above or inside TimelineStage.tsx. Transcription status changes
 * constantly and asynchronously, completely independent of a real commit() —
 * exactly the class of state CLAUDE.md's silence-removal section documents
 * as fatal to thread above TimelineStage: `processingClipId` did that once,
 * defeated the provider's `tracks === engineTracksRef.current` passthrough-
 * cache check, and forced a spurious full engine rebuild on every unrelated
 * re-render while it was in flight. This store exists specifically so that
 * bug never recurs for transcription — every reader (useTranscriptIndex.ts,
 * the filler-word-removal menu item's disabled check) lives below/beside
 * TimelineStage, never above it.
 */
interface TranscriptStoreState {
  transcripts: Record<string, AssetTranscript>;
  setTranscript: (transcript: AssetTranscript) => void;
}

export const useTranscriptStore = create<TranscriptStoreState>((set) => ({
  transcripts: {},
  setTranscript: (transcript) =>
    set((state) => ({
      transcripts: { ...state.transcripts, [transcript.assetId]: transcript },
    })),
}));
