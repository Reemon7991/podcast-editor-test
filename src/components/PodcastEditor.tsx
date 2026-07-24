"use client";

import { useCallback } from "react";
import { TimelineStage } from "./timeline/TimelineStage";
import { useTimelineTracks } from "../hooks/useTimelineTracks";
import { useClipActions } from "../hooks/useClipActions";

export function PodcastEditor() {
  const { tracks, setTracks, addTrack, removeTrack, addFilesToTrack, isLoading } =
    useTimelineTracks();
  const { duplicateClip, deleteClip } = useClipActions({ setTracks });

  // WaveformPlaylistProvider's onRemoveTrack gives a track *index* (it's a
  // Waveform-level UI callback, not aware of our id-keyed state) — resolve it
  // back to a stable id before mutating state.
  const handleRemoveTrackByIndex = useCallback(
    (trackIndex: number) => {
      const track = tracks[trackIndex];
      if (track) removeTrack(track.id);
    },
    [tracks, removeTrack]
  );

  return (
    <div className="flex w-full flex-col gap-4">
      <TimelineStage
        tracks={tracks}
        onTracksChange={setTracks}
        onRemoveTrack={handleRemoveTrackByIndex}
        deferEngineRebuild={isLoading}
        onAddTrack={addTrack}
        onAddFilesToTrack={addFilesToTrack}
        onDuplicateClip={duplicateClip}
        onDeleteClip={deleteClip}
      />
    </div>
  );
}
