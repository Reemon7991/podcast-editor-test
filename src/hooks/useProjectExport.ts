"use client";

import { useCallback, useState } from "react";
import type { ClipTrack } from "@waveform-playlist/browser";
import { useExportWav } from "@waveform-playlist/browser/tone";
import { audibleIndices } from "../utils/audibleTracks";
import { encodeCompressed, downloadBlob, exportFileExtension, type ExportFormat } from "../utils/exportFormats";

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
 * Wraps @waveform-playlist/browser/tone's useExportWav for a full mixdown,
 * in either WAV or a compressed format (utils/exportFormats.ts).
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
 *
 * Compressed formats reuse the exact same render (mixdown/fades/solo-mute)
 * WAV already produces — exportWav is called with autoDownload:false so its
 * own WAV download is skipped, and the returned AudioBuffer is re-encoded via
 * utils/exportFormats.ts's encodeCompressed instead. `isEncoding` covers that
 * extra step so the caller's busy state (and editor-blocking overlay) stays
 * up continuously — exportWav's own isExporting already flips back to false
 * once the render+WAV-encode finishes, before compression even starts.
 */
export function useProjectExport(tracks: ClipTrack[], trackStates: TrackMixerState[]) {
  const { exportWav, isExporting: isRendering, error: renderError } = useExportWav();
  const [isEncoding, setIsEncoding] = useState(false);
  const [encodeError, setEncodeError] = useState<string | null>(null);

  const exportProject = useCallback(
    async (format: ExportFormat) => {
      setEncodeError(null);

      // Nothing to render at all — bail before touching exportWav/isExporting
      // so no spinner/overlay flashes for an export that was never going to
      // produce anything. Distinct from (and checked before) the existing
      // solo/mute-driven "audibleTracks is empty" case below, which is a real
      // render that happens to contain silence, not an empty timeline.
      const hasClips = tracks.some((track) => track.clips.length > 0);
      if (!hasClips) {
        alert("Your podcast is empty, nothing to export.");
        return;
      }

      const indices = audibleIndices(trackStates);
      const audibleTracks = indices.map((i) => tracks[i]);
      const audibleStates = indices.map((i) => ({
        muted: false,
        soloed: false,
        volume: trackStates[i].volume,
        pan: trackStates[i].pan,
      }));
      const timestamp = timestampForFilename(new Date());

      if (format === "wav") {
        return exportWav(audibleTracks, audibleStates, {
          filename: `podcast-export-${timestamp}`,
          mode: "master",
        });
      }

      // exportWav still throws "No tracks to export" for an empty
      // audibleTracks array (the solo/mute-silences-everything case) —
      // propagates through here the same way it does for WAV, no special
      // casing needed.
      const result = await exportWav(audibleTracks, audibleStates, {
        filename: `podcast-export-${timestamp}`,
        mode: "master",
        autoDownload: false,
      });

      setIsEncoding(true);
      try {
        const blob = await encodeCompressed(result.audioBuffer, format);
        downloadBlob(
          blob,
          `podcast-export-${timestamp}-${format}kbps.${exportFileExtension(format)}`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Export failed";
        setEncodeError(message);
        throw err;
      } finally {
        setIsEncoding(false);
      }
    },
    [tracks, trackStates, exportWav]
  );

  return {
    exportProject,
    isExporting: isRendering || isEncoding,
    error: renderError ?? encodeError,
  };
}
