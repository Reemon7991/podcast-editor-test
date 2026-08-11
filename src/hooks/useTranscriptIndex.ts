"use client";

import { useMemo } from "react";
import type { ClipTrack } from "@waveform-playlist/browser";
import { getAssetId } from "../utils/assetRegistry";
import { wordsInWindow } from "../utils/transcriptWindow";
import { useTranscriptStore } from "../store/transcriptStore";
import type { ClipWordIndex } from "../utils/transcriptSearch";

/**
 * Builds a ClipWordIndex (utils/transcriptSearch.ts) from the live,
 * *hydrated* `tracks` (usePlaylistData().tracks — real AudioClips, not
 * ClipMeta) plus transcriptStore's current transcripts. See
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 5.
 *
 * `isTranscribing` covers the one real wait this app's search UI has: if
 * any clip's asset transcript hasn't settled yet (still "pending"/
 * "transcribing"), the caller should hold off on showing results — per the
 * plan's explicit UX call, search must never surface "transcription in
 * progress" as its own concept; it just silently waits.
 *
 * `tracks` is `AudioClip`, not `ClipMeta` — it has no `assetId` field
 * directly (that's ClipMeta-only, see utils/types.ts). `getAssetId`
 * resolves it back via the same buffer-object-reference binding
 * registerAsset established at upload/hydration time — same approach
 * useRemoveSilence.ts already uses for the same reason.
 */
export function useTranscriptIndex(tracks: ClipTrack[]): {
  index: ClipWordIndex[];
  isTranscribing: boolean;
} {
  const transcripts = useTranscriptStore((s) => s.transcripts);

  return useMemo(() => {
    const index: ClipWordIndex[] = [];
    let isTranscribing = false;

    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.midiNotes) continue; // audio-only feature, same guard used elsewhere
        if (!clip.audioBuffer) continue; // defensive — every hydrated clip reaching here should have one
        const assetId = getAssetId(clip.audioBuffer);
        const transcript = assetId ? transcripts[assetId] : undefined;
        if (!transcript) continue; // predates this feature, or compression failed — nothing to index

        if (transcript.status === "pending" || transcript.status === "transcribing") {
          isTranscribing = true;
          continue;
        }
        if (transcript.status !== "done" || !transcript.words) continue;

        const windowed = wordsInWindow(
          transcript.words,
          clip.offsetSamples / clip.sampleRate,
          clip.durationSamples / clip.sampleRate
        );
        if (windowed.length === 0) continue;

        index.push({
          trackId: track.id,
          clipId: clip.id,
          clipName: clip.name ?? track.name,
          words: windowed.map((w) => ({
            word: w.word,
            timelineStart: clip.startSample / clip.sampleRate + w.start,
          })),
        });
      }
    }

    return { index, isTranscribing };
  }, [tracks, transcripts]);
}
