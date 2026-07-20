"use client";

import { useCallback, useState } from "react";
import { TrackListBar } from "./import/TrackListBar";
import { TimelineStage } from "./timeline/TimelineStage";
import { useTimelineTracks } from "./audio-engine/useTimelineTracks";

export function PodcastEditor() {
  const { tracks, setTracks, addTrack, removeTrack, addFilesToTrack, isLoading } =
    useTimelineTracks();
  const [gapSeconds, setGapSeconds] = useState(0);

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
      <TrackListBar
        tracks={tracks}
        onAddTrack={addTrack}
        onAddFilesToTrack={(trackId, files) =>
          addFilesToTrack(trackId, files, gapSeconds)
        }
        gapSeconds={gapSeconds}
        onGapSecondsChange={setGapSeconds}
      />

      <TimelineStage
        tracks={tracks}
        onTracksChange={setTracks}
        onRemoveTrack={handleRemoveTrackByIndex}
        deferEngineRebuild={isLoading}
      />
    </div>
  );
}
