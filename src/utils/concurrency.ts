// Small, generic concurrency-limited fan-out helper — no React/DOM
// dependency, Node-testable. Pulled out as its own pure util (not inlined
// into transcription.ts) since it has no dependency on what it's actually
// running and could be reused anywhere else in this app that fans out N
// independent async calls (currently: transcribeChunk in transcription.ts).

/**
 * Same contract as `Promise.allSettled(items.map(run))` — one settled result
 * per item, in `items`' own order — except at most `limit` calls to `run`
 * are ever in flight at once. Added after a real gap found in
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 3: firing every chunk of
 * a long asset's transcription simultaneously (a 3-hour podcast at the
 * default 10-min chunk size is 18 chunks) is a real way to trigger upstream
 * rate limiting that a bounded burst wouldn't.
 */
export async function settleWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        const value = await run(items[index]);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
