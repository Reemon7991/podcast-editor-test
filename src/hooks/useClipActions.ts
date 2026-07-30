"use client";

import { useCallback } from "react";
import type { ClipMeta } from "../utils/types";
import { resolveNonOverlappingStart } from "../utils/clipGeometry";
import { useProjectStore } from "../store/projectStore";

/**
 * Clip-level mutations (duplicate/delete), split out from useTimelineTracks
 * (track-level: add/remove track, import files) so each hook owns one
 * concern. Both commit to the same Zustand project store (undo/redo-able),
 * just via `commit` read directly from the store rather than a setter passed
 * down from useTimelineTracks.
 *
 * Clip splitting isn't here: it goes through the library's own
 * `useClipSplitting`/`engine.splitClip()` (see
 * `clip-menu/ClipActionsOverlay.tsx`), which updates the same store via
 * `TimelineStage.tsx`'s `onTracksChange` wrapper without the full engine
 * rebuild a plain commit forces — unlike duplicate/delete, a hand-rolled
 * split would also have to reimplement its pixel-snapping and
 * minimum-duration guards to be correct.
 *
 * The stop()-if-playing guard for these two mutations lives in
 * `ClipActionsOverlay.tsx`, not here — this hook is owned by
 * `PodcastEditor.tsx`, outside the provider tree, and structurally can't
 * reach `usePlaylistControls().stop()`/`usePlaybackAnimation().isPlaying`.
 */
export function useClipActions() {
  const commit = useProjectStore((s) => s.commit);

  /** Placed immediately after the source clip on the same track (not on top
   * of it) so the copy is visibly distinct without needing a drag — matches
   * most DAWs' "duplicate" placement. Pushed forward past whatever it would
   * otherwise have overlapped there, same as every other clip-placement path
   * in this app (uploads, drag/drop) — a clip already sitting right after
   * the source would otherwise get silently covered by the duplicate. */
  const duplicateClip = useCallback(
    (trackId: string, clipId: string) => {
      commit(
        (prev) =>
          prev.map((track) => {
            if (track.id !== trackId) return track;
            const clip = track.clips.find((c) => c.id === clipId);
            if (!clip) return track;
            const otherClips = track.clips.filter((c) => c.id !== clip.id);
            const startSample = resolveNonOverlappingStart(
              clip.startSample + clip.durationSamples,
              clip.durationSamples,
              otherClips
            );
            const duplicate: ClipMeta = {
              ...clip,
              id: crypto.randomUUID(),
              startSample,
            };
            return { ...track, clips: [...track.clips, duplicate] };
          }),
        "Duplicate clip"
      );
    },
    [commit]
  );

  const deleteClip = useCallback(
    (trackId: string, clipId: string) => {
      commit(
        (prev) =>
          prev.map((track) =>
            track.id === trackId
              ? { ...track, clips: track.clips.filter((c) => c.id !== clipId) }
              : track
          ),
        "Delete clip"
      );
    },
    [commit]
  );

  return { duplicateClip, deleteClip };
}
