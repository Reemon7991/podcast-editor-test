// Shared "which words are audible in this window" filter — used by both
// useTranscriptIndex.ts (Phase 5: a clip's own offsetSamples/durationSamples
// window into its asset, for search and filler-word detection) and
// transcriptRemap.ts (Phase 4: the same windowing as the first step before
// remapping through a splice's keepRanges). Defined once so the rule can't
// drift between the two. See TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md.

import type { TranscriptWord } from "./types";

export interface WindowedWord {
  word: string;
  /** Seconds relative to the window's own start (e.g. a clip's
   *  offsetSamples/sampleRate) — NOT the asset. Can be negative, or exceed
   *  the window's own duration, for a word that overlaps a window edge
   *  without being fully inside it (see the overlap-vs-containment note
   *  below) — callers that need strict containment (transcriptRemap.ts)
   *  check the bounds themselves rather than this function silently
   *  clipping/dropping them. */
  start: number;
  end: number;
}

/**
 * Filters `words` (asset-relative seconds) to those whose `[start,end)`
 * *overlaps* `[windowStartSeconds, windowStartSeconds+windowDurationSeconds)`,
 * remapped to be relative to the window's own start. Overlap, not strict
 * containment — a word straddling the window's edge (e.g. a clip trimmed
 * mid-word) still counts, matching the plan's explicit choice for search
 * ("only words whose timestamp falls inside some clip's currently-used
 * window" is about the window test itself, not a stricter full-containment
 * rule that would silently exclude a word the user can still partially
 * hear). Callers needing strict containment (a splice's keepRanges) test the
 * returned clip-relative bounds themselves — an overlapping-but-not-fully-
 * contained word naturally fails that stricter check without this function
 * needing two modes.
 */
export function wordsInWindow(
  words: TranscriptWord[],
  windowStartSeconds: number,
  windowDurationSeconds: number
): WindowedWord[] {
  const windowEndSeconds = windowStartSeconds + windowDurationSeconds;
  const result: WindowedWord[] = [];
  for (const w of words) {
    if (w.end > windowStartSeconds && w.start < windowEndSeconds) {
      result.push({ word: w.word, start: w.start - windowStartSeconds, end: w.end - windowStartSeconds });
    }
  }
  return result;
}
