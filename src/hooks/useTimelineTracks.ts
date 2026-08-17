"use client";

import { useCallback, useState } from "react";
import * as Tone from "tone";
import { hashFileBytes, registerAsset } from "../utils/assetRegistry";
import { saveAsset, saveCompressedAsset } from "../utils/persistence";
import { resolveNonOverlappingStart } from "../utils/clipGeometry";
import { buildClipMeta } from "../utils/clipInsertion";
import { compressAssetToChunks } from "../utils/audioCompression";
import { runTranscriptionPipeline } from "../utils/transcription";
import type { ClipMeta } from "../utils/types";
import { createEmptyTrack, useProjectStore } from "../store/projectStore";

interface DecodedFile {
  file: File;
  audioBuffer: AudioBuffer;
  assetId: string;
}

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
  // A saveAsset failure (quota, private browsing) used to be console-only —
  // the clip still works this session (registerAsset already has the
  // in-memory buffer), but silently won't survive a reload. Surfacing it lets
  // PodcastEditor.tsx warn the user instead of them finding out via a missing
  // clip after their next reload.
  const [saveWarning, setSaveWarning] = useState<string | null>(null);

  // Mints the id upfront (rather than letting createEmptyTrack pick one)
  // so the caller can select the new track right away, before the commit
  // above has even landed — see EditorShell.tsx's "+ New Track" handler.
  const addTrack = useCallback(() => {
    const id = crypto.randomUUID();
    commit((prev) => [...prev, createEmptyTrack(prev.length + 1, id)], "Add track");
    return id;
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
        let assetSaveFailures = 0;
        let compressionFailures = 0;
        const results = await Promise.allSettled(
          files.map(async (file): Promise<DecodedFile> => {
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
            // session, it just won't survive a reload. Counted (not just
            // logged) so the caller can warn the user post-batch — see
            // saveWarning's own doc comment.
            const [audioBuffer] = await Promise.all([
              audioContext.decodeAudioData(arrayBuffer),
              saveAsset(assetId, file).catch((err) => {
                console.error("[podcast-editor] Failed to persist asset to IndexedDB", err);
                assetSaveFailures += 1;
              }),
            ]);
            registerAsset(audioBuffer, assetId);

            // Compress (chunk + Opus-encode) and persist the compressed
            // chunks — awaited, so the loading overlay this hook drives
            // (isLoading, below) stays up until this finishes, per
            // TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's UX requirement.
            // Transcription itself is kicked off but NOT awaited — it
            // continues in the background after the overlay clears and the
            // user can already start editing. A compression failure is
            // logged/counted and swallowed, same non-fatal treatment a
            // saveAsset failure already gets above: the clip still works for
            // editing/playback, it just won't be searchable and won't offer
            // filler-word removal.
            try {
              const chunks = await compressAssetToChunks(audioContext, audioBuffer);
              await saveCompressedAsset(assetId, chunks);
              void runTranscriptionPipeline(assetId, chunks, audioBuffer.sampleRate);
            } catch (err) {
              console.error("[podcast-editor] Failed to compress asset for transcription", err);
              compressionFailures += 1;
            }

            return { file, audioBuffer, assetId };
          })
        );

        // Both warnings are independent (a save failure doesn't imply a
        // compression failure or vice versa) and combined rather than
        // if/else'd — a batch where one file hits each shouldn't silently
        // drop one of the two messages.
        const warnings: string[] = [];
        if (assetSaveFailures > 0) {
          warnings.push(
            assetSaveFailures === 1
              ? "1 clip couldn't be saved for offline use — it will be lost if you reload before exporting."
              : `${assetSaveFailures} clips couldn't be saved for offline use — they will be lost if you reload before exporting.`
          );
        }
        if (compressionFailures > 0) {
          warnings.push(
            compressionFailures === 1
              ? "1 clip couldn't be prepared for transcription — it won't be searchable or offer filler-word removal."
              : `${compressionFailures} clips couldn't be prepared for transcription — they won't be searchable or offer filler-word removal.`
          );
        }
        if (warnings.length > 0) setSaveWarning(warnings.join(" "));

        commit(
          (prev) =>
            prev.map((track) => {
              if (track.id !== trackId) return track;
              const decoded = results.filter(
                (r): r is PromiseFulfilledResult<DecodedFile> => r.status === "fulfilled"
              );
              if (decoded.length === 0) return track;
              const sampleRate = decoded[0].value.audioBuffer.sampleRate;
              const totalDurationSamples = decoded.reduce(
                (sum, r) => sum + r.value.audioBuffer.length,
                0
              );
              // The batch is laid out contiguously starting here — pushed
              // forward, as one block, past whatever it would otherwise have
              // overlapped, rather than stacking on top of an existing clip.
              let cursor = resolveNonOverlappingStart(
                Math.round(insertionTimeSeconds * sampleRate),
                totalDurationSamples,
                track.clips
              );
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
                const startSample: number = cursor;
                appended.push(
                  buildClipMeta(assetId, audioBuffer, startSample, file.name.replace(/\.[^/.]+$/, ""))
                );
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
    saveWarning,
    dismissSaveWarning: () => setSaveWarning(null),
  };
}
