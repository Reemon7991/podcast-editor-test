"use client";

import { useState } from "react";
import { WaveformPlaylistProvider, type ClipTrack } from "@waveform-playlist/browser";
import { EditorShell } from "./EditorShell";
import { TRACK_WAVE_HEIGHT } from "./trackLayout";

interface TimelineStageProps {
  tracks: ClipTrack[];
  onTracksChange: (tracks: ClipTrack[]) => void;
  onRemoveTrack: (trackIndex: number) => void;
  /** True while any clip is still decoding — defers the (expensive) Tone.js
   *  engine rebuild until the whole import batch settles, so adding several
   *  files doesn't trigger a rebuild per file. */
  deferEngineRebuild: boolean;
  onAddTrack: () => void;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
}

export function TimelineStage({
  tracks,
  onTracksChange,
  onRemoveTrack,
  deferEngineRebuild,
  onAddTrack,
  onAddFilesToTrack,
}: TimelineStageProps) {
  const [providerError, setProviderError] = useState<string | null>(null);

  if (providerError) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Failed to build timeline: {providerError}
      </p>
    );
  }

  return (
    <WaveformPlaylistProvider
      tracks={tracks}
      onTracksChange={onTracksChange}
      samplesPerPixel={1024}
      waveHeight={TRACK_WAVE_HEIGHT}
      mono
      timescale
      controls={{ show: true, width: 180 }}
      deferEngineRebuild={deferEngineRebuild}
      onError={(err) => setProviderError(err.message)}
    >
      <EditorShell
        onRemoveTrack={onRemoveTrack}
        onAddTrack={onAddTrack}
        onAddFilesToTrack={onAddFilesToTrack}
      />
    </WaveformPlaylistProvider>
  );
}
