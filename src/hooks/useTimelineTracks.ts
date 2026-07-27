"use client";

import { useCallback, useState } from "react";
import * as Tone from "tone";
import { hashFileBytes, registerAsset } from "../utils/assetRegistry";
import { saveAsset } from "../utils/persistence";
import type { ClipMeta } from "../utils/types";
import { createEmptyTrack, useProjectStore } from "../store/projectStore";

/**
 * Track/clip identity is stable across renders. State (`present`) lives in
 * the Zustand project store, not local component state — every mutation
 * goes through `commit(update, label)` so it's undo/redo-able (see
 * store/projectStore.ts and PERSISTENCE_UNDO_ORIGINAL_PLAN.md's Phase 2).
 * `TimelineStage.tsx` is the sole boundary that joins `present` (`TrackMeta[]`,
 * metadata only, no decoded audio) with real audio via hydrate()/dehydrate()
 * before it reaches WaveformPlaylistProvider.
 *
 * `commit` itself stops playback first if needed (see projectStore.ts's
 * `stopIfPlaying`/`registerStopIfPlaying`) — addFilesToTrack doesn't need its
 * own guard even though it's async (decode happens before the commit below):
 * `commit` reads *current* isPlaying at the moment it actually runs, which is
 * exactly when this call happens, right after decode settles.
 */
export function useTimelineTracks() {
  const tracks = useProjectStore((s) => s.present);
  const commit = useProjectStore((s) => s.commit);
  const [loadingCount, setLoadingCount] = useState(0);

  const addTrack = useCallback(() => {
    commit((prev) => [...prev, createEmptyTrack(prev.length + 1)], "Add track");
  }, [commit]);

  const removeTrack = useCallback(
    (trackId: string) => {
      commit((prev) => prev.filter((t) => t.id !== trackId), "Remove track");
    },
    [commit]
  );

  /**
   * Decodes every file in the batch concurrently (fast), but only commits
   * them to `trackId` once the whole batch settles, in the original
   * file-selection order — appending each clip as soon as its own decode
   * resolved (the previous approach) let a smaller/faster file jump ahead of
   * one selected before it, since decode completion order isn't the same as
   * selection order. Positioning is computed once at commit time — it does
   * NOT re-lay-out clips the user has since dragged elsewhere on the track.
   *
   * `commit`'s updater reads `prev` from the store at the moment this
   * eventually runs (after the `await`s below), not a `tracks` value closed
   * over at call time — critical here specifically, since this is the one
   * mutation in this app with a real async gap between "user action" and
   * "commit": another commit (a drag, another import) landing during decode
   * must not be silently reverted. See projectStore.ts's `commit` doc comment.
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
            // Decode and persist concurrently — persistence is a Phase 3
            // add-on to an already-working import path, so a save failure
            // (quota, private browsing) is logged and swallowed rather than
            // failing the import itself; the clip still works for this
            // session, it just won't survive a reload.
            const [audioBuffer] = await Promise.all([
              audioContext.decodeAudioData(arrayBuffer),
              saveAsset(assetId, file).catch((err) => {
                console.error("[podcast-editor] Failed to persist asset to IndexedDB", err);
              }),
            ]);
            registerAsset(audioBuffer, assetId);
            return { file, audioBuffer, assetId };
          })
        );

        commit(
          (prev) =>
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
            }),
          "Import clips"
        );

        setLoadingCount((c) => c - files.length);
      })();
    },
    [commit]
  );

  return {
    tracks,
    addTrack,
    removeTrack,
    addFilesToTrack,
    isLoading: loadingCount > 0,
  };
}
