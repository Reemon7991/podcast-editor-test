import type { AudioClip, ClipTrack } from "@waveform-playlist/browser";
import { getAssetBuffer, getAssetId } from "./assetRegistry";
import type { ClipMeta, TrackMeta } from "./types";

/**
 * hydrate()/dehydrate() are the only reason ClipDragLayer.tsx,
 * ClipActionsOverlay.tsx, useScissorsSplit.ts, and clipGeometry.ts need zero
 * changes for this layer — they all read `tracks` via the library's own
 * usePlaylistData() context, which is populated from whatever hydrate()
 * produced. See PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Core mechanism"
 * section for the full design, including why a per-track memoization cache
 * (below) is load-bearing and not just an optimization: without it, every
 * hydrate() call allocates a brand new object graph, which would defeat
 * WaveformPlaylistProvider's own reference-identity rebuild-avoidance checks
 * (isEngineTracks / isIncrementalAdd) and turn routine edits like add-track
 * into full engine rebuilds.
 */

const hydratedTrackCache = new WeakMap<TrackMeta, ClipTrack>();

function hydrateClip(clip: ClipMeta): AudioClip {
  const { assetId, ...rest } = clip;
  return { ...rest, audioBuffer: getAssetBuffer(assetId) };
}

function hydrateTrack(track: TrackMeta): ClipTrack {
  const cached = hydratedTrackCache.get(track);
  if (cached) return cached;
  const hydrated: ClipTrack = { ...track, clips: track.clips.map(hydrateClip) };
  hydratedTrackCache.set(track, hydrated);
  return hydrated;
}

/** Joins persisted/undo-safe metadata with the in-memory decoded audio it
 *  refers to, producing the shape WaveformPlaylistProvider actually needs. */
export function hydrate(tracks: TrackMeta[]): ClipTrack[] {
  return tracks.map(hydrateTrack);
}

const dehydratedTrackCache = new WeakMap<ClipTrack, TrackMeta>();

function dehydrateTrack(track: ClipTrack): TrackMeta {
  const cached = dehydratedTrackCache.get(track);
  if (cached) return cached;
  const dehydrated: TrackMeta = { ...track, clips: track.clips.map(dehydrateClip) };
  dehydratedTrackCache.set(track, dehydrated);
  return dehydrated;
}

function dehydrateClip(clip: AudioClip): ClipMeta {
  const { audioBuffer, ...rest } = clip;
  // Every clip that reaches dehydrate() in this app originates from
  // addFilesToTrack (registers an assetId before the clip is ever built) or
  // from a library-driven trim/split/duplicate that carries an existing
  // clip's audioBuffer through by reference (already registered). Throwing
  // here surfaces a genuine invariant violation immediately instead of
  // silently persisting a clip with no way to recover its audio later.
  if (!audioBuffer) {
    throw new Error(`[podcast-editor] dehydrate: clip "${clip.id}" has no audioBuffer`);
  }
  const assetId = getAssetId(audioBuffer);
  if (!assetId) {
    throw new Error(
      `[podcast-editor] dehydrate: clip "${clip.id}"'s audioBuffer was never registered in the asset registry`
    );
  }
  return { ...rest, assetId };
}

/**
 * Strips decoded audio back out to the persisted/undo-safe shape, resolving
 * each clip's `assetId` from the registry it was registered under.
 *
 * Per-track memoized (see `dehydratedTrackCache` above), same as `hydrate()`
 * — load-bearing for trim's live preview, not just an optimization: a
 * boundary drag's `onDragMove` (confirmed in
 * `@waveform-playlist/browser/dist/index.js`) rebuilds only the *one* track
 * containing the trimmed clip on every pointer-move frame and returns every
 * sibling track by the same object reference — so without this cache,
 * `dehydrate()` was re-processing every clip in the whole session on every
 * frame of every trim, not just the one clip actually changing. Harmless for
 * a small session; for this app's actual target (2-3 hour podcasts, many
 * tracks/clips), that made trimming visibly heavier than before this
 * boundary existed. With the cache, only the changed track's clips get
 * re-mapped per frame — everything else is an O(1) WeakMap hit.
 */
export function dehydrate(tracks: ClipTrack[]): TrackMeta[] {
  return tracks.map(dehydrateTrack);
}
