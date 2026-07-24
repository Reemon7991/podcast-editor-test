"use client";

import { useCallback, useState } from "react";
import * as Tone from "tone";
import { hashFileBytes, registerAsset } from "./persistence/assetRegistry";
import type { ClipMeta, TrackMeta } from "./persistence/types";

function createEmptyTrack(index: number): TrackMeta {
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
 * Track/clip identity is stable across renders. State here is `TrackMeta[]`
 * (metadata only, no decoded audio) — TimelineStage.tsx is the sole
 * boundary that joins it with real audio via hydrate()/dehydrate() before
 * it reaches WaveformPlaylistProvider; see
 * audio-engine/persistence/clipHydration.ts and
 * PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Core mechanism" section for why, and
 * for how engine-driven moves (same-track drag) still get to feed back into
 * this same state via reference-identity rebuild-skipping despite that
 * boundary sitting in between.
 */
export function useTimelineTracks() {
  const [tracks, setTracks] = useState<TrackMeta[]>(() => [createEmptyTrack(1)]);
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
    (trackId: string, files: File[], insertionTimeSeconds: number) => {
      if (files.length === 0) return;
      setLoadingCount((c) => c + files.length);

      (async () => {
        const audioContext = Tone.getContext().rawContext as AudioContext;
        const results = await Promise.allSettled(
          files.map(async (file) => {
            const arrayBuffer = await file.arrayBuffer();
            // Hash before decoding, not after — see assetRegistry.ts's
            // hashFileBytes doc comment on why (decodeAudioData buffer
            // detachment). assetId is content-addressed so two independent
            // uploads of the same bytes dedupe for free.
            const assetId = await hashFileBytes(arrayBuffer);
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            registerAsset(audioBuffer, assetId);
            return { file, audioBuffer, assetId };
          })
        );

        setTracks((prev) =>
          prev.map((track) => {
            if (track.id !== trackId) return track;
            let cursor = 0;
            let cursorInitialized = false;
            const appended: ClipMeta[] = [];
            for (const result of results) {
              if (result.status === "rejected") {
                console.error(
                  "[podcast-editor] Failed to decode file",
                  result.reason
                );
                continue;
              }
              const { file, audioBuffer, assetId } = result.value;
              if (!cursorInitialized) {
                cursor = Math.round(insertionTimeSeconds * audioBuffer.sampleRate);
                cursorInitialized = true;
              }
              const startSample: number = cursor;
              appended.push({
                id: crypto.randomUUID(),
                assetId,
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
