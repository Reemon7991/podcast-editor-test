"use client";

import { useCallback } from "react";
import type { ClipTrack } from "@waveform-playlist/browser";
import { useExportWav } from "@waveform-playlist/browser/tone";
import { audibleIndices } from "../utils/audibleTracks";

interface TrackMixerState {
  muted: boolean;
  soloed: boolean;
  volume: number;
  pan: number;
}

/** Local timestamp, no colons — safe as a filename, e.g. "20260728-143000". */
function timestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Wraps @waveform-playlist/browser/tone's useExportWav for a full mixdown.
 *
 * Takes `tracks`/`trackStates` from usePlaylistData() (the live engine state),
 * not the app's own `present` store — mute/solo/volume/pan changes never flow
 * back through onTracksChange (confirmed by reading the vendored dist source:
 * they only bump the engine's `mixerVersion`, which onTracksChange doesn't
 * watch), so `present` never reflects them. usePlaylistData()'s trackStates
 * does, since it's the same state the Mute/Solo buttons themselves read.
 *
 * Also pre-filters via audibleIndices instead of trusting exportWav's own
 * solo/mute filter — see its doc comment for the mismatch this avoids.
 */
export function useProjectExport(tracks: ClipTrack[], trackStates: TrackMixerState[]) {
  const { exportWav, isExporting, error } = useExportWav();

  const exportProject = useCallback(() => {
    const indices = audibleIndices(trackStates);
    const audibleTracks = indices.map((i) => tracks[i]);
    const audibleStates = indices.map((i) => ({
      muted: false,
      soloed: false,
      volume: trackStates[i].volume,
      pan: trackStates[i].pan,
    }));
    const filename = `podcast-export-${timestampForFilename(new Date())}`;
    return exportWav(audibleTracks, audibleStates, { filename, mode: "master" });
  }, [tracks, trackStates, exportWav]);

  return { exportProject, isExporting, error };
}
