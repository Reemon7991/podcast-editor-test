"use client";

import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { loadProject, loadAssets, loadTranscripts, loadCompressedAsset } from "../utils/persistence";
import { registerAsset } from "../utils/assetRegistry";
import { useProjectStore } from "../store/projectStore";
import { useTranscriptStore } from "../store/transcriptStore";
import { runTranscriptionPipeline } from "../utils/transcription";
import type { TrackMeta } from "../utils/types";

/**
 * Mount-time effect: loads the persisted project (if any) from IndexedDB,
 * decodes every asset it references, and re-registers each buffer under its
 * *persisted* assetId — critical: minting a fresh one here (the way
 * addFilesToTrack does at upload time) would orphan every ClipMeta.assetId
 * already baked into the loaded tracks, since assetRegistry.ts never mints
 * ids itself. See PERSISTENCE_UNDO_ORIGINAL_PLAN.md's Phase 3.
 *
 * Wrapped in try/catch: any failure along this path (private-browsing
 * storage block, quota error, a corrupt record) falls back to the store's
 * own default single-empty-track project instead of surfacing an error —
 * never a permanent loading screen, per the plan's own requirement.
 *
 * A per-asset decode failure or a missing blob (the assets store doesn't
 * implement GC yet, see CLAUDE.md's "Known limitations", but could still be
 * cleared out-of-band, e.g. by the browser evicting storage) is handled one
 * level more granularly than that: rather than failing the whole hydration,
 * only the clips referencing the unresolved asset are dropped — leaving a
 * clip with no audioBuffer in the hydrated tracks would otherwise reach
 * WaveformPlaylistProvider broken, not just be visually wrong.
 *
 * That drop used to be console-only — real, silent data loss with nothing in
 * the UI to indicate it, on a codepath (storage quota/eviction, private
 * browsing) plausible at this app's actual target scale (2-3 hour podcasts,
 * many large asset blobs). `hydrationWarning` surfaces the dropped-clip count
 * so PodcastEditor.tsx can render it instead of relying on someone having the
 * console open.
 */
export function useProjectHydration(): {
  isProjectHydrating: boolean;
  hydrationWarning: string | null;
  dismissHydrationWarning: () => void;
} {
  const [isProjectHydrating, setIsProjectHydrating] = useState(true);
  const [hydrationWarning, setHydrationWarning] = useState<string | null>(null);
  const replacePresent = useProjectStore((s) => s.replacePresent);
  // Guards against React Strict Mode's dev-only double-invoke of effects —
  // re-running this would re-decode every asset and call replacePresent a
  // second time for no reason (harmless but wasteful, and briefly re-flips
  // isProjectHydrating back to true).
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;

    (async () => {
      try {
        const tracks = await loadProject();
        if (!tracks) return; // fresh IndexedDB — keep the store's default project

        const assetIds = Array.from(
          new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)))
        );
        const blobsByAssetId = await loadAssets(assetIds);

        const audioContext = Tone.getContext().rawContext as AudioContext;
        const decodedAssetIds = new Set<string>();
        const sampleRateByAssetId = new Map<string, number>();
        await Promise.all(
          assetIds.map(async (assetId) => {
            const blob = blobsByAssetId.get(assetId);
            if (!blob) {
              console.warn(
                `[podcast-editor] Asset "${assetId}" missing from IndexedDB — dropping clips that reference it`
              );
              return;
            }
            try {
              const arrayBuffer = await blob.arrayBuffer();
              const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
              registerAsset(audioBuffer, assetId);
              decodedAssetIds.add(assetId);
              sampleRateByAssetId.set(assetId, audioBuffer.sampleRate);
            } catch (err) {
              console.error(`[podcast-editor] Failed to decode asset "${assetId}"`, err);
            }
          })
        );

        // Repopulate transcriptStore for every asset that survived hydration
        // — it's in-memory only (see its own doc comment on why it's
        // deliberately never wired into projectStore/TimelineStage), so
        // without this, search/filler-word removal would silently show "no
        // transcript" for every asset after every reload. Any transcript
        // still "pending"/"transcribing" (tab closed mid-flight) is
        // re-kicked against its already-persisted compressed chunks — cheap,
        // no re-decode/re-compress needed.
        const decodedAssetIdList = Array.from(decodedAssetIds);
        const transcriptsByAssetId = await loadTranscripts(decodedAssetIdList);
        const { setTranscript } = useTranscriptStore.getState();
        for (const transcript of transcriptsByAssetId.values()) {
          setTranscript(transcript);
        }
        await Promise.all(
          decodedAssetIdList.map(async (assetId) => {
            const transcript = transcriptsByAssetId.get(assetId);
            if (!transcript || (transcript.status !== "pending" && transcript.status !== "transcribing")) {
              return;
            }
            const chunks = await loadCompressedAsset(assetId);
            const sampleRate = sampleRateByAssetId.get(assetId);
            if (chunks && chunks.length > 0 && sampleRate) {
              void runTranscriptionPipeline(assetId, chunks, sampleRate);
            }
          })
        );

        let droppedClipCount = 0;
        const hydratableTracks: TrackMeta[] = tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => {
            const kept = decodedAssetIds.has(clip.assetId);
            if (!kept) droppedClipCount += 1;
            return kept;
          }),
        }));

        if (droppedClipCount > 0) {
          setHydrationWarning(
            droppedClipCount === 1
              ? "1 clip couldn't be restored — its audio data was missing or corrupted."
              : `${droppedClipCount} clips couldn't be restored — their audio data was missing or corrupted.`
          );
        }

        replacePresent(hydratableTracks);
      } catch (err) {
        console.error(
          "[podcast-editor] Failed to load persisted project, starting fresh",
          err
        );
      } finally {
        setIsProjectHydrating(false);
      }
    })();
  }, [replacePresent]);

  return {
    isProjectHydrating,
    hydrationWarning,
    dismissHydrationWarning: () => setHydrationWarning(null),
  };
}
