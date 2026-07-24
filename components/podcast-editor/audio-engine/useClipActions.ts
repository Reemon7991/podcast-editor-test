"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { ClipMeta, TrackMeta } from "./persistence/types";

interface UseClipActionsOptions {
  setTracks: Dispatch<SetStateAction<TrackMeta[]>>;
}

/**
 * Clip-level mutations (duplicate/delete), split out from useTimelineTracks
 * (track-level: add/remove track, import files) so each hook owns one
 * concern. Both still mutate the same `tracks` state, just via the setter
 * passed in from useTimelineTracks rather than owning the state themselves.
 *
 * Clip splitting isn't here: it goes through the library's own
 * `useClipSplitting`/`engine.splitClip()` (see
 * `clip-menu/ClipActionsOverlay.tsx`), which updates this same state via
 * `onTracksChange` without the full engine rebuild a plain `setTracks` call
 * forces — unlike duplicate/delete, a hand-rolled split would also have to
 * reimplement its pixel-snapping and minimum-duration guards to be correct.
 */
export function useClipActions({ setTracks }: UseClipActionsOptions) {
  /** Appended immediately after the source clip on the same track (not on
   * top of it) so the copy is visibly distinct without needing a drag —
   * matches most DAWs' "duplicate" placement. */
  const duplicateClip = useCallback(
    (trackId: string, clipId: string) => {
      setTracks((prev) =>
        prev.map((track) => {
          if (track.id !== trackId) return track;
          const clip = track.clips.find((c) => c.id === clipId);
          if (!clip) return track;
          const duplicate: ClipMeta = {
            ...clip,
            id: crypto.randomUUID(),
            startSample: clip.startSample + clip.durationSamples,
          };
          return { ...track, clips: [...track.clips, duplicate] };
        })
      );
    },
    [setTracks]
  );

  const deleteClip = useCallback(
    (trackId: string, clipId: string) => {
      setTracks((prev) =>
        prev.map((track) =>
          track.id === trackId
            ? { ...track, clips: track.clips.filter((c) => c.id !== clipId) }
            : track
        )
      );
    },
    [setTracks]
  );

  return { duplicateClip, deleteClip };
}
