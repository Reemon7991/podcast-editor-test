// Transcript -> filler-word removal ranges. Pure, no React/DOM dependency,
// Node-testable — same "pure util + thin hook" split silenceDetection.ts /
// useRemoveSilence.ts already established. Mechanically the same pipeline as
// silence removal (detect ranges to remove -> merge nearby -> invert to
// keepRanges -> splice via clipSplice.ts's spliceKeepRanges), just driven by
// transcript word matches instead of an RMS threshold. See
// TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 6.

import type { KeepRange } from "./clipSplice";
import type { TranscriptWord } from "./types";
import { wordsInWindow } from "./transcriptWindow";
import { isFillerWord, fillerWordDisplayLabel, normalizeFillerCandidate } from "./fillerWords";

export interface FillerWordMatch {
  /** Original transcript spelling (punctuation stripped) — used for the
   *  confirmation summary. */
  word: string;
  /** Clip-relative samples (0 = offsetSamples), same coordinate space as
   *  KeepRange/clipSplice.ts. */
  startSample: number;
  endSample: number;
}

export interface FillerWordDetectionOptions {
  /** Padding kept on each side of a cut, pulled in from the detected word
   *  boundary — small on purpose: Whisper's own word timestamps are already
   *  reasonably tight, unlike silence detection's threshold-crossing
   *  boundaries (silenceDetection.ts pads 0.1s by default; a filler word's
   *  boundary doesn't need as much lead-in/lead-out). */
  paddingSeconds?: number;
  /** Two padded cuts closer than this are merged into one, so a tiny kept
   *  sliver between back-to-back filler words ("um, uh,") doesn't survive
   *  as an audible stutter. */
  mergeGapSeconds?: number;
}

const DEFAULT_OPTIONS: Required<FillerWordDetectionOptions> = {
  paddingSeconds: 0.05,
  mergeGapSeconds: 0.15,
};

export interface FillerWordDetectionResult {
  /** Every matched filler word, chronological — empty means nothing to
   *  remove. Drives the "Found: 12 'um', 4 'uh'" confirmation summary
   *  (see summarizeFillerWordMatches below). */
  matches: FillerWordMatch[];
  /** Ready for clipSplice.ts's spliceKeepRanges — a single full-clip range
   *  when matches is empty, same no-op convention
   *  silenceDetection.ts's detectKeepRanges uses. */
  keepRanges: KeepRange[];
}

/**
 * Scans `transcriptWords` (asset-relative seconds) for filler-word matches
 * inside a clip's own [offsetSamples, offsetSamples+durationSamples) window,
 * and turns them into keepRanges ready to splice.
 */
export function detectFillerWords(
  transcriptWords: TranscriptWord[],
  offsetSamples: number,
  durationSamples: number,
  sampleRate: number,
  options?: FillerWordDetectionOptions
): FillerWordDetectionResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const durationSeconds = durationSamples / sampleRate;
  const windowed = wordsInWindow(transcriptWords, offsetSamples / sampleRate, durationSeconds);

  // Only words fully contained in the clip's own window are safe to cut —
  // one straddling the clip's edge (wordsInWindow is overlap-, not
  // containment-based; see its own doc comment) is left alone, same
  // "don't touch what you can't fully see" rule transcriptRemap.ts already
  // applies to a word straddling a splice boundary.
  const matches: FillerWordMatch[] = windowed
    .filter((w) => w.start >= 0 && w.end <= durationSeconds && isFillerWord(w.word))
    .map((w) => ({
      word: fillerWordDisplayLabel(w.word),
      startSample: Math.round(w.start * sampleRate),
      endSample: Math.round(w.end * sampleRate),
    }));

  if (matches.length === 0) {
    return { matches: [], keepRanges: [{ startSample: 0, endSample: durationSamples }] };
  }

  const paddingSamples = Math.round(opts.paddingSeconds * sampleRate);
  const mergeGapSamples = Math.round(opts.mergeGapSeconds * sampleRate);

  // Pad each match outward, clamped to the clip's own bounds — no padding
  // manufactures phantom content past either edge, same guard
  // silenceDetection.ts's own padding step applies at a buffer's absolute
  // start/end.
  const padded = matches
    .map((m) => ({
      startSample: Math.max(0, m.startSample - paddingSamples),
      endSample: Math.min(durationSamples, m.endSample + paddingSamples),
    }))
    .sort((a, b) => a.startSample - b.startSample);

  // Merge ranges that touch or are within mergeGapSamples of each other.
  const mergedRemove: KeepRange[] = [];
  for (const range of padded) {
    const last = mergedRemove[mergedRemove.length - 1];
    if (last && range.startSample - last.endSample <= mergeGapSamples) {
      last.endSample = Math.max(last.endSample, range.endSample);
    } else {
      mergedRemove.push({ ...range });
    }
  }

  // Invert into ascending, non-overlapping keepRanges. Deliberately no
  // silence-removal-style "fold tiny kept slivers" pass here — considered
  // and rejected, not just omitted: silenceDetection.ts's own
  // mergeTinyKeptRanges is safe to apply broadly because whatever kept
  // sliver survives between two threshold-crossing silence runs is
  // presumptively near-silent junk. That assumption does NOT hold here — a
  // short kept segment between two filler-word cuts is real audio the user
  // never asked to remove (possibly a genuine short word, e.g. "no"), so
  // unconditionally dropping it on length alone risks deleting real content
  // rather than junk. Proximity between cuts is already fully handled by
  // mergeGapSeconds above (every surviving *interior* kept range is
  // provably longer than mergeGapSamples, by construction of the merge loop
  // — there is nothing left for a second, redundant length-based filter to
  // catch there). The one edge this doesn't cover — a filler word starting/
  // ending very close to the clip's own boundary, which the merge loop
  // can't touch since there's no earlier/later cut to merge with — is a
  // real but low-severity, disclosed gap (utils/fillerWords.ts's own doc
  // comment): it could leave a very brief residual sliver right at a clip's
  // edge, not a content-loss risk (see CLAUDE.md's filler-word-removal
  // section).
  const keepRanges: KeepRange[] = [];
  let cursor = 0;
  for (const remove of mergedRemove) {
    if (remove.startSample > cursor) {
      keepRanges.push({ startSample: cursor, endSample: remove.startSample });
    }
    cursor = Math.max(cursor, remove.endSample);
  }
  if (cursor < durationSamples) {
    keepRanges.push({ startSample: cursor, endSample: durationSamples });
  }

  return { matches, keepRanges };
}

export interface FillerWordSummaryEntry {
  /** Original-casing spelling of the first match seen for this group — not
   *  the normalized dictionary key, so Arabic script/English casing reads
   *  naturally instead of as a canonicalized token. */
  label: string;
  count: number;
}

/** Groups matches by their normalized form (so "Um" and "um," count
 *  together) for the "Found: 12 'um', 4 'uh'" confirmation summary — insertion
 *  order (first-seen), not sorted by count, so the summary reads in the same
 *  order the clip's own words do. */
export function summarizeFillerWordMatches(matches: FillerWordMatch[]): FillerWordSummaryEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, FillerWordSummaryEntry>();
  for (const match of matches) {
    const key = normalizeFillerCandidate(match.word);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { label: match.word, count: 1 });
      order.push(key);
    }
  }
  return order.map((key) => byKey.get(key)!);
}
