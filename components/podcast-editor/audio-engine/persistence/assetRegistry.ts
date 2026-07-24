/**
 * Module-level, never part of React/Zustand state — maps a clip's
 * content-addressed `assetId` to the decoded `AudioBuffer` it refers to (and
 * back), so `ClipMeta` (persistence/undo-safe, no `audioBuffer`) can be
 * re-joined with real audio data on demand. See
 * PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Core mechanism" section.
 *
 * This registry never mints an id itself — `assetId` is always a known
 * value at the call site: a content hash computed by `hashFileBytes` at
 * upload time (useTimelineTracks.ts), or a persisted id read back from
 * IndexedDB at rehydration time (Phase 3).
 */

const buffersById = new Map<string, AudioBuffer>();
const idsByBuffer = new WeakMap<AudioBuffer, string>();

/** Binds `buffer` and `assetId` to each other in both directions. */
export function registerAsset(buffer: AudioBuffer, assetId: string): void {
  buffersById.set(assetId, buffer);
  idsByBuffer.set(buffer, assetId);
}

export function getAssetBuffer(assetId: string): AudioBuffer | undefined {
  return buffersById.get(assetId);
}

/**
 * Resolves the assetId already bound to this exact buffer object, if any.
 * Used by dehydrate() for clips produced by the library's own splitClip()
 * (confirmed via @waveform-playlist/engine/dist/index.js — see the plan),
 * which passes `audioBuffer` through by the same object reference to both
 * halves without re-decoding, so the split clips resolve to the same
 * assetId as the clip they came from.
 */
export function getAssetId(buffer: AudioBuffer): string | undefined {
  return idsByBuffer.get(buffer);
}

/**
 * SHA-256 of the raw file bytes, hex-encoded — this is what `assetId` is
 * minted from at upload time, replacing what would otherwise be a random
 * UUID. Two independent uploads of identical bytes (e.g. the same intro
 * jingle reused across episodes) then mint the same `assetId`, so dedup
 * falls out for free everywhere `assetId` is used as a key — no separate
 * reverse-lookup step needed, here or in Phase 3's IndexedDB storage.
 *
 * Hash the raw ArrayBuffer *before* handing it to decodeAudioData, not
 * after — some engines have historically neutered (detached) the buffer
 * passed to decodeAudioData, so hashing first sidesteps the question of
 * whether that still holds on whatever browser this runs in.
 */
export async function hashFileBytes(arrayBuffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
