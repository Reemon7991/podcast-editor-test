// Pure word-index search logic — no React/DOM dependency, Node-testable.
// See TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 5. Deliberately
// separate from the reactive hook that builds the index
// (hooks/useTranscriptIndex.ts) — same "pure util + thin hook" split this
// app already uses for silenceDetection.ts/useRemoveSilence.ts.

export interface ClipWordEntry {
  word: string;
  /** Seconds on the *project timeline* — already includes the clip's own
   *  position (startSample), not asset- or clip-relative. */
  timelineStart: number;
}

export interface ClipWordIndex {
  trackId: string;
  clipId: string;
  clipName: string;
  /** Ascending by timelineStart. */
  words: ClipWordEntry[];
}

export interface SearchResult {
  trackId: string;
  clipId: string;
  clipName: string;
  /** The matched word(s), in their original transcript casing/punctuation
   *  — not the user's raw query. */
  matchText: string;
  /** Up to CONTEXT_WORD_COUNT words, chronological order. Fewer at a clip's
   *  own edge — never padded/faked. */
  contextBefore: string[];
  contextAfter: string[];
  /** Seconds on the project timeline where the match begins. */
  timelineStart: number;
  /** A little before timelineStart (clamped to 0) — where a caller should
   *  seek so the user hears the lead-in, not just the exact match. */
  seekTimelineStart: number;
}

export const CONTEXT_WORD_COUNT = 2;
const SEEK_LEAD_IN_SECONDS = 0.5;

/**
 * Case-insensitive phrase search: splits `query` on whitespace into terms,
 * then finds every run of consecutive words in each clip where each word
 * *contains* the corresponding term (so "ell" matches "Hello", and a
 * multi-word query like "the fox" requires two consecutive words). Simple
 * on purpose — no fuzzy matching, no stemming; a v1 scope call, easy to
 * upgrade later without touching the index shape.
 */
export function searchClipWordIndex(index: ClipWordIndex[], query: string): SearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: SearchResult[] = [];
  for (const clip of index) {
    const { words } = clip;
    for (let i = 0; i + terms.length <= words.length; i++) {
      let matched = true;
      for (let t = 0; t < terms.length; t++) {
        if (!words[i + t].word.toLowerCase().includes(terms[t])) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const matchWords = words.slice(i, i + terms.length);
      const timelineStart = matchWords[0].timelineStart;
      results.push({
        trackId: clip.trackId,
        clipId: clip.clipId,
        clipName: clip.clipName,
        matchText: matchWords.map((w) => w.word).join(" "),
        contextBefore: words.slice(Math.max(0, i - CONTEXT_WORD_COUNT), i).map((w) => w.word),
        contextAfter: words.slice(i + terms.length, i + terms.length + CONTEXT_WORD_COUNT).map((w) => w.word),
        timelineStart,
        seekTimelineStart: Math.max(0, timelineStart - SEEK_LEAD_IN_SECONDS),
      });
    }
  }

  // Chronological, not insertion order across tracks — reads as "in the
  // order they occur in the podcast," matching how a user thinks about it.
  results.sort((a, b) => a.timelineStart - b.timelineStart);
  return results;
}

/** A common word ("the") can match hundreds of times across a real podcast —
 *  rendering all of them is both a performance problem and a usability one
 *  (hundreds of unranked, unstyled rows with no way to tell which one is
 *  relevant). Kept separate from searchClipWordIndex rather than folded into
 *  it: the search algorithm's own contract (every match, chronological
 *  order) stays simple and independently testable; capping is a
 *  presentation concern layered on top, applied by the caller. */
export const MAX_SEARCH_RESULTS = 50;

export interface CappedSearchResults {
  /** At most MAX_SEARCH_RESULTS, same chronological order as the input. */
  results: SearchResult[];
  /** The true match count before capping. */
  totalMatches: number;
  truncated: boolean;
}

export function capSearchResults(results: SearchResult[]): CappedSearchResults {
  const totalMatches = results.length;
  const truncated = totalMatches > MAX_SEARCH_RESULTS;
  return { results: truncated ? results.slice(0, MAX_SEARCH_RESULTS) : results, totalMatches, truncated };
}
