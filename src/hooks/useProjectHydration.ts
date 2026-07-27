"use client";

import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { loadProject, loadAssets } from "../utils/persistence";
import { registerAsset } from "../utils/assetRegistry";
import { useProjectStore } from "../store/projectStore";
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
 */
export function useProjectHydration(): { isProjectHydrating: boolean } {
  const [isProjectHydrating, setIsProjectHydrating] = useState(true);
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
            } catch (err) {
              console.error(`[podcast-editor] Failed to decode asset "${assetId}"`, err);
            }
          })
        );

        const hydratableTracks: TrackMeta[] = tracks.map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => decodedAssetIds.has(clip.assetId)),
        }));

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

  return { isProjectHydrating };
}
