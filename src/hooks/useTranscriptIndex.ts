"use client";

import { useMemo } from "react";
import type { ClipTrack } from "@waveform-playlist/browser";
import { getAssetId } from "../utils/assetRegistry";
import { wordsInWindow } from "../utils/transcriptWindow";
import { useTranscriptStore } from "../store/transcriptStore";
import type { ClipWordIndex } from "../utils/transcriptSearch";
import type { TranscriptWord } from "../utils/types";

// Module-level, not useRef — this repo's eslint-plugin-react-hooks "refs"
// rule rejects reading ref.current during render even inside useMemo (see
// CLAUDE.md's Phase 1 notes); same reason assetRegistry.ts's own cache is
// module-level too.
const clipCache = new Map<string, ClipCacheEntry>();

/**
 * Builds a ClipWordIndex (utils/transcriptSearch.ts) from the live,
 * *hydrated* `tracks` (usePlaylistData().tracks — real AudioClips, not
 * ClipMeta) plus transcriptStore's current transcripts. See
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 5.
 *
 * `isTranscribing` covers the one real wait this app's search UI has: if
 * any clip's asset transcript hasn't settled yet, the caller should hold off
 * on showing results — search must never surface "transcription in
 * progress" as its own concept.
 *
 * `tracks` is `AudioClip`, not `ClipMeta` — `getAssetId` resolves the
 * assetId back via the same buffer-reference binding useRemoveSilence.ts
 * already uses.
 *
 * Per-clip memoized (`clipCache`) rather than recomputed flat every time —
 * `transcripts` is a new object on any single asset's update, so without
 * this an unrelated clip finishing would rescan every other clip's words
 * too. Same fix shape as `dehydrate()`'s own per-track cache (CLAUDE.md's
 * "Post-Phase-3 perf regression").
 */
export function useTranscriptIndex(tracks: ClipTrack[]): {
  index: ClipWordIndex[];
  isTranscribing: boolean;
} {
  const transcripts = useTranscriptStore((s) => s.transcripts);

  return useMemo(() => {
    const cache = clipCache;
    const seenClipIds = new Set<string>();
    const index: ClipWordIndex[] = [];
    let isTranscribing = false;

    for (const track of tracks) {
      for (const clip of track.clips) {
        if (clip.midiNotes) continue; // audio-only feature, same guard used elsewhere
        if (!clip.audioBuffer) continue; // defensive — every hydrated clip reaching here should have one
        seenClipIds.add(clip.id);

        const assetId = getAssetId(clip.audioBuffer);
        const transcript = assetId ? transcripts[assetId] : undefined;
        if (!transcript) {
          cache.delete(clip.id);
          continue; // predates this feature, or compression failed — nothing to index
        }

        if (transcript.status === "pending" || transcript.status === "transcribing") {
          isTranscribing = true;
          cache.delete(clip.id);
          continue;
        }
        if (transcript.status !== "done" || !transcript.words) {
          cache.delete(clip.id);
          continue;
        }

        const clipName = clip.name ?? track.name;
        const cached = cache.get(clip.id);
        const cacheHit =
          cached !== undefined &&
          cached.transcriptWords === transcript.words &&
          cached.offsetSamples === clip.offsetSamples &&
          cached.durationSamples === clip.durationSamples &&
          cached.startSample === clip.startSample &&
          cached.sampleRate === clip.sampleRate &&
          cached.clipName === clipName;

        let result: ClipWordIndex | null;
        if (cacheHit) {
          result = cached.result;
        } else {
          const windowed = wordsInWindow(
            transcript.words,
            clip.offsetSamples / clip.sampleRate,
            clip.durationSamples / clip.sampleRate
          );
          result =
            windowed.length > 0
              ? {
                  trackId: track.id,
                  clipId: clip.id,
                  clipName,
                  words: windowed.map((w) => ({
                    word: w.word,
                    timelineStart: clip.startSample / clip.sampleRate + w.start,
                  })),
                }
              : null;
          cache.set(clip.id, {
            transcriptWords: transcript.words,
            offsetSamples: clip.offsetSamples,
            durationSamples: clip.durationSamples,
            startSample: clip.startSample,
            sampleRate: clip.sampleRate,
            clipName,
            result,
          });
        }

        if (result) index.push(result);
      }
    }

    // Evict entries for clips no longer on the timeline.
    for (const clipId of cache.keys()) {
      if (!seenClipIds.has(clipId)) cache.delete(clipId);
    }

    return { index, isTranscribing };
  }, [tracks, transcripts]);
}

interface ClipCacheEntry {
  /** Reference equality, not deep — transcriptStore replaces this array
   *  wholesale, never mutates in place. */
  transcriptWords: TranscriptWord[];
  offsetSamples: number;
  durationSamples: number;
  startSample: number;
  sampleRate: number;
  clipName: string;
  result: ClipWordIndex | null;
}
