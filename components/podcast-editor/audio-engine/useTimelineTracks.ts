"use client";

import { useCallback, useState } from "react";
import * as Tone from "tone";
import type { AudioClip, ClipTrack } from "@waveform-playlist/browser";

function createEmptyTrack(index: number): ClipTrack {
  return {
    id: crypto.randomUUID(),
    name: `Track ${index}`,
    clips: [],
    muted: false,
    soloed: false,
    volume: 1,
    pan: 0,
  };
}

/**
 * Owns the multi-track timeline as persisted state (not a value recomputed
 * from scratch each render). This matters once clips can be dragged: a pure
 * "recompute positions from an import list" approach — the previous
 * single-track design — would silently discard any manual drag the moment
 * something else (a new import, a gap change) triggered a recompute.
 *
 * Track/clip identity is stable across renders, and WaveformPlaylistProvider's
 * onTracksChange callback (wired in TimelineStage) feeds engine-driven moves
 * (same-track drag) straight back into this same `tracks` state, using the
 * exact array reference the engine handed back — see WaveformPlaylistProvider's
 * docs on reference-identity rebuild-skipping.
 */
export function useTimelineTracks() {
  const [tracks, setTracks] = useState<ClipTrack[]>(() => [createEmptyTrack(1)]);
  const [loadingCount, setLoadingCount] = useState(0);

  const addTrack = useCallback(() => {
    setTracks((prev) => [...prev, createEmptyTrack(prev.length + 1)]);
  }, []);

  const removeTrack = useCallback((trackId: string) => {
    setTracks((prev) => prev.filter((t) => t.id !== trackId));
  }, []);

  /**
   * Decodes every file in the batch concurrently (fast), but only commits
   * them to `trackId` once the whole batch settles, in the original
   * file-selection order — appending each clip as soon as its own decode
   * resolved (the previous approach) let a smaller/faster file jump ahead of
   * one selected before it, since decode completion order isn't the same as
   * selection order. Positioning is computed once at commit time — it does
   * NOT re-lay-out clips the user has since dragged elsewhere on the track.
   */
  const addFilesToTrack = useCallback(
    (trackId: string, files: File[], gapSeconds: number) => {
      if (files.length === 0) return;
      setLoadingCount((c) => c + files.length);

      (async () => {
        const audioContext = Tone.getContext().rawContext as AudioContext;
        const results = await Promise.allSettled(
          files.map(async (file) => {
            const arrayBuffer = await file.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            return { file, audioBuffer };
          })
        );

        setTracks((prev) =>
          prev.map((track) => {
            if (track.id !== trackId) return track;
            let cursor = track.clips.reduce(
              (max, c) => Math.max(max, c.startSample + c.durationSamples),
              0
            );
            const appended: AudioClip[] = [];
            for (const result of results) {
              if (result.status === "rejected") {
                console.error(
                  "[podcast-editor] Failed to decode file",
                  result.reason
                );
                continue;
              }
              const { file, audioBuffer } = result.value;
              const gapSamples =
                track.clips.length === 0 && appended.length === 0
                  ? 0
                  : Math.round(gapSeconds * audioBuffer.sampleRate);
              const startSample = cursor + gapSamples;
              appended.push({
                id: crypto.randomUUID(),
                audioBuffer,
                startSample,
                durationSamples: audioBuffer.length,
                offsetSamples: 0,
                sampleRate: audioBuffer.sampleRate,
                sourceDurationSamples: audioBuffer.length,
                gain: 1,
                name: file.name.replace(/\.[^/.]+$/, ""),
              });
              cursor = startSample + audioBuffer.length;
            }
            return { ...track, clips: [...track.clips, ...appended] };
          })
        );

        setLoadingCount((c) => c - files.length);
      })();
    },
    []
  );

  return {
    tracks,
    setTracks,
    addTrack,
    removeTrack,
    addFilesToTrack,
    isLoading: loadingCount > 0,
  };
}
