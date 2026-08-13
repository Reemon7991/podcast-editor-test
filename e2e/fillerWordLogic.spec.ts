import { test, expect } from "@playwright/test";
import { isFillerWord, normalizeFillerCandidate, fillerWordDisplayLabel } from "../src/utils/fillerWords";
import { detectFillerWords, summarizeFillerWordMatches } from "../src/utils/fillerWordDetection";
import type { TranscriptWord } from "../src/utils/types";

/**
 * Pure-function coverage for TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's
 * Phase 6 — same "plain in-process Node test, no browser" shape
 * transcriptionLogic.spec.ts already established for the rest of this
 * plan's pure logic. Promotes this feature's own scratchpad verification
 * (a real Cartesia -> OpenRouter round trip confirming Whisper's actual
 * spelling of "um"/"uh"/their Arabic equivalents, including punctuation and
 * alef-form drift) into permanent regression coverage.
 */

const sampleRate = 1000; // 1 sample per ms — easy exact math below.

test.describe("isFillerWord / normalizeFillerCandidate (fillerWords.ts)", () => {
  test("recognizes English filler words regardless of casing/punctuation", () => {
    expect(isFillerWord("Um,")).toBe(true);
    expect(isFillerWord("uh?")).toBe(true);
    expect(isFillerWord("UHH")).toBe(true);
    expect(isFillerWord("erm")).toBe(true);
    expect(isFillerWord("ah")).toBe(true);
  });

  test("collapses an elongated interjection to its canonical form before matching", () => {
    expect(isFillerWord("ummmm")).toBe(true);
    expect(normalizeFillerCandidate("ummmm")).toBe("umm");
  });

  test("does not match ordinary English words, even short ones", () => {
    expect(isFillerWord("committee")).toBe(false);
    expect(isFillerWord("am")).toBe(false);
    expect(isFillerWord("a")).toBe(false);
    expect(isFillerWord("hello")).toBe(false);
  });

  test("recognizes Arabic filler words including real Whisper spelling drift", () => {
    // Confirmed live: a script's plain bare-alef "اه" came back from a real
    // TTS -> Whisper round trip spelled with the madda form "آه" plus a
    // trailing Arabic comma — both must normalize to the same match.
    expect(isFillerWord("آه،")).toBe(true);
    expect(isFillerWord("اه")).toBe(true);
    expect(isFillerWord("اهههه")).toBe(true); // elongated
    expect(isFillerWord("امم")).toBe(true);
  });

  test("does not match a real Arabic word even when it looks close to a filler", () => {
    // Bare alef-mim ("ام") is also "mother" once diacritics are stripped —
    // deliberately excluded from the dictionary for exactly this reason
    // (same ambiguity class that ruled out English "like").
    expect(isFillerWord("ام")).toBe(false);
    expect(isFillerWord("مرحباً")).toBe(false);
    expect(isFillerWord("البودكاست")).toBe(false);
  });

  test("fillerWordDisplayLabel strips punctuation but preserves original casing/script", () => {
    expect(fillerWordDisplayLabel("Um,")).toBe("Um");
    expect(fillerWordDisplayLabel("آه،")).toBe("آه");
  });
});

test.describe("detectFillerWords (fillerWordDetection.ts)", () => {
  test("no fillers present -> empty matches, single unchanged keepRange", () => {
    const words: TranscriptWord[] = [
      { word: "Hello", start: 0, end: 0.3 },
      { word: "world", start: 0.3, end: 0.6 },
    ];
    const result = detectFillerWords(words, 0, 1000, sampleRate);
    expect(result.matches).toEqual([]);
    expect(result.keepRanges).toEqual([{ startSample: 0, endSample: 1000 }]);
  });

  test("one isolated filler word is cut, with padding on both sides", () => {
    const words: TranscriptWord[] = [
      { word: "Hello", start: 0, end: 0.2 },
      { word: "um,", start: 0.4, end: 0.5 },
      { word: "world", start: 0.8, end: 1.0 },
    ];
    const result = detectFillerWords(words, 0, 1000, sampleRate, { paddingSeconds: 0.05, mergeGapSeconds: 0.15 });
    expect(result.matches).toEqual([{ word: "um", startSample: 400, endSample: 500 }]);
    expect(result.keepRanges).toEqual([
      { startSample: 0, endSample: 350 },
      { startSample: 550, endSample: 1000 },
    ]);
  });

  test("back-to-back filler words within the merge gap collapse into one cut", () => {
    const words: TranscriptWord[] = [
      { word: "Hello", start: 0, end: 0.2 },
      { word: "um", start: 0.3, end: 0.4 },
      { word: "uh", start: 0.42, end: 0.5 },
      { word: "world", start: 0.8, end: 1.0 },
    ];
    const result = detectFillerWords(words, 0, 1000, sampleRate, { paddingSeconds: 0.05, mergeGapSeconds: 0.15 });
    expect(result.matches).toHaveLength(2);
    expect(result.keepRanges).toEqual([
      { startSample: 0, endSample: 250 },
      { startSample: 550, endSample: 1000 },
    ]);
  });

  test("padding at a clip's own edge is clamped, never negative or past the end", () => {
    const words: TranscriptWord[] = [
      { word: "um", start: 0, end: 0.1 },
      { word: "Hello", start: 0.3, end: 0.5 },
    ];
    const result = detectFillerWords(words, 0, 1000, sampleRate, { paddingSeconds: 0.05, mergeGapSeconds: 0.15 });
    expect(result.keepRanges).toEqual([{ startSample: 150, endSample: 1000 }]);
  });

  test("a clip that is entirely merged filler words removes everything (empty keepRanges)", () => {
    const words: TranscriptWord[] = [
      { word: "um", start: 0, end: 0.2 },
      { word: "uh", start: 0.25, end: 0.5 },
      { word: "erm", start: 0.55, end: 1.0 },
    ];
    const result = detectFillerWords(words, 0, 1000, sampleRate, { paddingSeconds: 0.05, mergeGapSeconds: 0.15 });
    expect(result.keepRanges).toEqual([]);
  });

  test("a word straddling the clip's own edge is left untouched (overlap, not containment)", () => {
    const words: TranscriptWord[] = [
      { word: "um", start: -0.05, end: 0.1 }, // starts before this clip's own window
      { word: "Hello", start: 0.3, end: 0.5 },
    ];
    const result = detectFillerWords(words, 0, 1000, sampleRate);
    expect(result.matches).toEqual([]);
  });

  test("only words inside the clip's own offset/duration window are scanned", () => {
    const words: TranscriptWord[] = [
      { word: "um", start: 0.1, end: 0.2 }, // before this clip's window starts
      { word: "uh", start: 0.6, end: 0.7 }, // inside the window
      { word: "erm", start: 2.0, end: 2.1 }, // after this clip's window ends
    ];
    // Clip window: offsetSamples=500 (0.5s), durationSamples=500 (0.5s) -> [0.5s, 1.0s)
    const result = detectFillerWords(words, 500, 500, sampleRate);
    expect(result.matches.map((m) => m.word)).toEqual(["uh"]);
  });
});

test.describe("summarizeFillerWordMatches (fillerWordDetection.ts)", () => {
  test("groups by normalized form, counts occurrences, first-seen display casing and order", () => {
    const words: TranscriptWord[] = [
      { word: "Um,", start: 0, end: 0.1 },
      { word: "hello", start: 0.2, end: 0.3 },
      { word: "uh", start: 0.4, end: 0.5 },
      { word: "um", start: 0.6, end: 0.7 },
    ];
    const { matches } = detectFillerWords(words, 0, 1000, sampleRate);
    expect(summarizeFillerWordMatches(matches)).toEqual([
      { label: "Um", count: 2 },
      { label: "uh", count: 1 },
    ]);
  });

  test("empty matches summarize to an empty list", () => {
    expect(summarizeFillerWordMatches([])).toEqual([]);
  });
});
