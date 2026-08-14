// Builds a transcript for a spliced (silence-removed / filler-word-removed)
// clip's new asset by remapping the ORIGINAL asset's transcript through the
// splice's own keepRanges — no network call needed. See
// TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 4 ("Remap the old
// transcript through the known kept/removed ranges, locally, no network
// call — keeps splice-based features fast/free/client-side, matches silence
// removal's existing property exactly").

import type { KeepRange } from "./silenceDetection";
import type { TranscriptWord } from "./types";
import { wordsInWindow } from "./transcriptWindow";

/**
 * `sourceWords` is the original asset's full transcript (asset-relative
 * seconds). `clipOffsetSamples`/`clipDurationSamples`/`sampleRate` describe
 * the clip's own window into that asset *before* splicing. `keepRanges` are
 * spliceOutSilence's own output — sample offsets relative to the *clip's*
 * own start (0 = clipOffsetSamples), exclusive end, ascending order,
 * non-overlapping (see silenceDetection.ts's KeepRange doc comment).
 *
 * Returns a new word list in the *spliced* result's own asset-relative
 * seconds (0 = the start of the concatenated kept audio) — this is what the
 * caller persists as the new asset's AssetTranscript.words.
 *
 * A word only survives if it's fully contained within a single kept range.
 * One straddling a cut boundary — or the clip's own outer edge, since
 * wordsInWindow is overlap- not containment-based there — is dropped
 * entirely, not truncated: the simplest, safe default this plan explicitly
 * chose over trying to salvage a partial word.
 */
export function remapWordsThroughKeptRanges(
  sourceWords: TranscriptWord[],
  clipOffsetSamples: number,
  clipDurationSamples: number,
  sampleRate: number,
  keepRanges: KeepRange[]
): TranscriptWord[] {
  const windowed = wordsInWindow(sourceWords, clipOffsetSamples / sampleRate, clipDurationSamples / sampleRate);

  const keepRangesSeconds = keepRanges.map((r) => ({
    startSeconds: r.startSample / sampleRate,
    endSeconds: r.endSample / sampleRate,
  }));

  const result: TranscriptWord[] = [];
  let priorKeptDurationSeconds = 0;
  for (const range of keepRangesSeconds) {
    for (const w of windowed) {
      if (w.start >= range.startSeconds && w.end <= range.endSeconds) {
        result.push({
          word: w.word,
          start: priorKeptDurationSeconds + (w.start - range.startSeconds),
          end: priorKeptDurationSeconds + (w.end - range.startSeconds),
        });
      }
    }
    priorKeptDurationSeconds += range.endSeconds - range.startSeconds;
  }
  // keepRanges are ascending and non-overlapping, so words within each range
  // are already appended in a range-ascending block, but a range can itself
  // contain words in non-monotonic relative order only if the source
  // transcript did — sorting is cheap insurance, not a correctness patch for
  // anything observed.
  result.sort((a, b) => a.start - b.start);
  return result;
}
