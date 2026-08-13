import { test, expect } from "@playwright/test";
import { splitDurationIntoChunks, CHUNK_DURATION_SECONDS } from "../src/utils/audioCompression";
import { settleWithConcurrencyLimit } from "../src/utils/concurrency";
import { wordsInWindow } from "../src/utils/transcriptWindow";
import {
  searchClipWordIndex,
  capSearchResults,
  CONTEXT_WORD_COUNT,
  MAX_SEARCH_RESULTS,
  type ClipWordIndex,
} from "../src/utils/transcriptSearch";
import { remapWordsThroughKeptRanges } from "../src/utils/transcriptRemap";
import type { TranscriptWord } from "../src/utils/types";

/**
 * Pure-function coverage for TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's
 * Phases 1-5 — no browser, no server, just calling the functions directly
 * (same "plain in-process Node test" shape as ttsRoute.spec.ts uses for
 * route.ts). Promotes every scratchpad verification run ad-hoc during that
 * work into permanent regression coverage — see CLAUDE.md's own
 * self-critique note on why that previously wasn't committed anywhere.
 */

test.describe("splitDurationIntoChunks (audioCompression.ts)", () => {
  test("a clip shorter than the chunk size yields exactly one chunk covering it all", () => {
    expect(splitDurationIntoChunks(30, 600)).toEqual([{ startSeconds: 0, endSeconds: 30 }]);
  });

  test("exactly at the boundary still yields one chunk", () => {
    expect(splitDurationIntoChunks(600, 600)).toEqual([{ startSeconds: 0, endSeconds: 600 }]);
  });

  test("just over the boundary splits into two, no overlap", () => {
    expect(splitDurationIntoChunks(650, 600)).toEqual([
      { startSeconds: 0, endSeconds: 600 },
      { startSeconds: 600, endSeconds: 650 },
    ]);
  });

  test("a multi-hour duration produces contiguous, gap-free, non-overlapping chunks", () => {
    const chunks = splitDurationIntoChunks(7530, 600); // ~2h5m30s
    let coveredUntil = 0;
    for (const c of chunks) {
      expect(c.startSeconds).toBe(coveredUntil);
      coveredUntil = c.endSeconds;
    }
    expect(coveredUntil).toBe(7530);
    expect(chunks.length).toBe(13);
  });

  test("zero or negative duration yields no chunks", () => {
    expect(splitDurationIntoChunks(0)).toEqual([]);
    expect(splitDurationIntoChunks(-5)).toEqual([]);
  });

  test("the exported default matches the documented 10-minute value", () => {
    expect(CHUNK_DURATION_SECONDS).toBe(600);
  });
});

test.describe("settleWithConcurrencyLimit (concurrency.ts)", () => {
  test("never runs more than `limit` calls at once", async () => {
    let current = 0;
    let maxSeen = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await settleWithConcurrencyLimit(items, 3, async (i) => {
      current++;
      maxSeen = Math.max(maxSeen, current);
      await new Promise((r) => setTimeout(r, 20 - i)); // varying delays, out-of-order completion
      current--;
      return i;
    });
    expect(maxSeen).toBeLessThanOrEqual(3);
    expect(maxSeen).toBe(3); // confirms it actually reaches the limit, not just never exceeds it
  });

  test("results preserve input order regardless of completion order", async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await settleWithConcurrencyLimit(items, 2, async (i) => {
      await new Promise((r) => setTimeout(r, (5 - i) * 5)); // reverse completion order
      return i * 10;
    });
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([10, 20, 30, 40, 50]);
  });

  test("mixed fulfilled/rejected results are matched to the right item", async () => {
    const results = await settleWithConcurrencyLimit([1, 2, 3, 4], 2, async (i) => {
      if (i % 2 === 0) throw new Error(`fail-${i}`);
      return `ok-${i}`;
    });
    expect(results[0]).toMatchObject({ status: "fulfilled", value: "ok-1" });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "ok-3" });
    expect(results[3].status).toBe("rejected");
  });

  test("limit=1 fully serializes — no overlap", async () => {
    const order: string[] = [];
    await settleWithConcurrencyLimit([1, 2, 3], 1, async (i) => {
      order.push(`start-${i}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end-${i}`);
    });
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  test("empty input resolves to an empty array", async () => {
    const results = await settleWithConcurrencyLimit([], 3, async () => "never");
    expect(results).toEqual([]);
  });
});

function words(strs: string[], startSeconds = 0, stepSeconds = 0.5): TranscriptWord[] {
  return strs.map((word, i) => ({ word, start: startSeconds + i * stepSeconds, end: startSeconds + i * stepSeconds + 0.4 }));
}

test.describe("wordsInWindow (transcriptWindow.ts)", () => {
  test("keeps only words overlapping the window, remapped to window-relative seconds", () => {
    const source = words(["a", "b", "c", "d", "e"], 10); // 10, 10.5, 11, 11.5, 12
    const result = wordsInWindow(source, 10.5, 1); // window: [10.5, 11.5)
    expect(result.map((w) => w.word)).toEqual(["b", "c"]);
    expect(result[0].start).toBeCloseTo(0, 5); // 10.5 - 10.5
  });

  test("a word straddling the window edge still counts (overlap, not containment)", () => {
    const source: TranscriptWord[] = [{ word: "straddler", start: 9.8, end: 10.6 }];
    const result = wordsInWindow(source, 10, 5);
    expect(result).toHaveLength(1);
    expect(result[0].start).toBeCloseTo(-0.2, 5); // can be negative — caller decides what to do with it
  });

  test("a word entirely outside the window is excluded", () => {
    const source: TranscriptWord[] = [{ word: "outside", start: 0, end: 1 }];
    const result = wordsInWindow(source, 10, 5);
    expect(result).toEqual([]);
  });
});

test.describe("remapWordsThroughKeptRanges (transcriptRemap.ts)", () => {
  const sampleRate = 16000;

  test("a word inside a removed silence gap is dropped; survivors shift left by the gap size", () => {
    const sourceWords: TranscriptWord[] = [
      { word: "one", start: 0.5, end: 1.0 },
      { word: "two", start: 4.5, end: 5.0 }, // falls inside the removed [4,6) gap
      { word: "three", start: 7.0, end: 7.5 },
    ];
    const keepRanges = [
      { startSample: 0, endSample: 4 * sampleRate },
      { startSample: 6 * sampleRate, endSample: 10 * sampleRate },
    ];
    const result = remapWordsThroughKeptRanges(sourceWords, 0, 10 * sampleRate, sampleRate, keepRanges);

    expect(result.map((w) => w.word)).toEqual(["one", "three"]);
    expect(result[0].start).toBeCloseTo(0.5, 5);
    // 'three' was at 7.0s; the [4,6) cut removed 2s, so it lands at 7.0-2.0=5.0s.
    expect(result[1].start).toBeCloseTo(5.0, 5);
  });

  test("a word straddling a cut boundary is dropped entirely, not truncated", () => {
    const straddling: TranscriptWord[] = [{ word: "straddler", start: 3.9, end: 4.2 }];
    const keepRanges = [
      { startSample: 0, endSample: 4 * sampleRate },
      { startSample: 6 * sampleRate, endSample: 10 * sampleRate },
    ];
    const result = remapWordsThroughKeptRanges(straddling, 0, 10 * sampleRate, sampleRate, keepRanges);
    expect(result).toEqual([]);
  });

  test("respects the clip's own window into a larger asset", () => {
    const sourceWords: TranscriptWord[] = [
      { word: "before-clip", start: 0, end: 0.5 },
      { word: "inside", start: 3.0, end: 3.5 },
      { word: "after-clip", start: 9.0, end: 9.5 },
    ];
    // Clip covers [2s, 8s) of the asset (offsetSamples = 2s), one kept range
    // spanning the whole 6s clip, no internal cut.
    const result = remapWordsThroughKeptRanges(
      sourceWords,
      2 * sampleRate,
      6 * sampleRate,
      sampleRate,
      [{ startSample: 0, endSample: 6 * sampleRate }]
    );
    expect(result.map((w) => w.word)).toEqual(["inside"]);
    expect(result[0].start).toBeCloseTo(1.0, 5); // 3.0 - 2.0 (clip offset)
  });
});

function clipIndex(clipId: string, wordList: string[], startSeconds = 0, stepSeconds = 0.5): ClipWordIndex {
  return {
    trackId: "t1",
    clipId,
    clipName: `Clip ${clipId}`,
    words: wordList.map((word, i) => ({ word, timelineStart: startSeconds + i * stepSeconds })),
  };
}

test.describe("searchClipWordIndex (transcriptSearch.ts)", () => {
  const index = [
    clipIndex("c1", ["The", "quick", "brown", "Fox", "jumps", "over", "the", "lazy", "dog."]),
    clipIndex("c2", ["Hello,", "this", "is", "a", "test", "of", "search."], 100),
  ];

  test("single-word substring match is case-insensitive and preserves original casing/context", () => {
    const results = searchClipWordIndex(index, "fox");
    expect(results).toHaveLength(1);
    expect(results[0].matchText).toBe("Fox");
    expect(results[0].contextBefore).toEqual(["quick", "brown"]);
    expect(results[0].contextAfter).toEqual(["jumps", "over"]);
  });

  test("multi-word phrase match requires consecutive words", () => {
    const results = searchClipWordIndex(index, "brown fox");
    expect(results).toHaveLength(1);
    expect(results[0].matchText).toBe("brown Fox");
  });

  test("no fake context padding at a clip's own edges", () => {
    const results = searchClipWordIndex(index, "the");
    const first = results.find((r) => r.clipId === "c1" && r.timelineStart === 0);
    expect(first?.contextBefore).toEqual([]);

    const dogResults = searchClipWordIndex(index, "dog");
    expect(dogResults[0].contextAfter).toEqual([]);
  });

  test("no matches returns an empty array, not everything", () => {
    expect(searchClipWordIndex(index, "zzz_no_such_word")).toEqual([]);
  });

  test("a blank query returns no results", () => {
    expect(searchClipWordIndex(index, "   ")).toEqual([]);
  });

  test("results are ordered chronologically across clips", () => {
    const results = searchClipWordIndex(index, "the");
    for (let i = 1; i < results.length; i++) {
      expect(results[i].timelineStart).toBeGreaterThanOrEqual(results[i - 1].timelineStart);
    }
  });

  test("seekTimelineStart is the match start minus a lead-in, clamped to 0", () => {
    const results = searchClipWordIndex(index, "the");
    const nearStart = results.find((r) => r.timelineStart < 0.5);
    expect(nearStart?.seekTimelineStart).toBe(0);
    const later = results.find((r) => r.timelineStart >= 0.5);
    expect(later!.seekTimelineStart).toBeCloseTo(later!.timelineStart - 0.5, 5);
  });

  test("context caps out at CONTEXT_WORD_COUNT", () => {
    expect(CONTEXT_WORD_COUNT).toBe(2);
    const results = searchClipWordIndex(index, "over");
    expect(results[0].contextBefore.length).toBeLessThanOrEqual(CONTEXT_WORD_COUNT);
    expect(results[0].contextAfter.length).toBeLessThanOrEqual(CONTEXT_WORD_COUNT);
  });
});

test.describe("capSearchResults (transcriptSearch.ts)", () => {
  // A single clip repeating "the" far more than MAX_SEARCH_RESULTS times —
  // the real-world case this exists for (a common word matching hundreds of
  // times across a podcast).
  const manyMatchesIndex = [clipIndex("c1", Array(MAX_SEARCH_RESULTS + 20).fill("the"))];
  const fewMatchesIndex = [clipIndex("c1", ["the", "quick", "the", "fox"])];

  test("below the cap: nothing is truncated, totalMatches equals the result count", () => {
    const outcome = capSearchResults(searchClipWordIndex(fewMatchesIndex, "the"));
    expect(outcome.truncated).toBe(false);
    expect(outcome.totalMatches).toBe(2);
    expect(outcome.results).toHaveLength(2);
  });

  test("above the cap: results are capped at MAX_SEARCH_RESULTS, truncated is true, totalMatches keeps the real count", () => {
    const all = searchClipWordIndex(manyMatchesIndex, "the");
    expect(all).toHaveLength(MAX_SEARCH_RESULTS + 20); // sanity: the uncapped search itself returns every match

    const outcome = capSearchResults(all);
    expect(outcome.truncated).toBe(true);
    expect(outcome.totalMatches).toBe(MAX_SEARCH_RESULTS + 20);
    expect(outcome.results).toHaveLength(MAX_SEARCH_RESULTS);
  });

  test("capping keeps the first MAX_SEARCH_RESULTS in their existing (chronological) order, not a re-sort/re-rank", () => {
    const all = searchClipWordIndex(manyMatchesIndex, "the");
    const outcome = capSearchResults(all);
    expect(outcome.results).toEqual(all.slice(0, MAX_SEARCH_RESULTS));
  });

  test("exactly MAX_SEARCH_RESULTS matches is not truncated (boundary, not off-by-one)", () => {
    const exactIndex = [clipIndex("c1", Array(MAX_SEARCH_RESULTS).fill("the"))];
    const outcome = capSearchResults(searchClipWordIndex(exactIndex, "the"));
    expect(outcome.truncated).toBe(false);
    expect(outcome.results).toHaveLength(MAX_SEARCH_RESULTS);
  });
});
