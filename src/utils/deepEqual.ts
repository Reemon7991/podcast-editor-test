/**
 * Structural equality, independent of object key insertion order — needed
 * because the same logical TrackMeta[]/ClipMeta content can arrive as two
 * different object graphs (app-constructed vs. re-hydrated from the engine's
 * own internal normalization), and a reference or JSON.stringify comparison
 * would treat those as different when they're not. See
 * projectStore.ts's `commitEngineOutput` doc comment for why this matters:
 * distinguishing a genuine content change from the engine's own mirror-back
 * echo of something we already committed ourselves.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
  );
}
