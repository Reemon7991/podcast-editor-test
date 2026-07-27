"use client";

import { useCallback, useEffect, useRef } from "react";
import { TimelineStage } from "./timeline/TimelineStage";
import { useTimelineTracks } from "../hooks/useTimelineTracks";
import { useClipActions } from "../hooks/useClipActions";
import { useProjectHydration } from "../hooks/useProjectHydration";
import { saveProject } from "../utils/persistence";

/** Trailing-edge debounce for the persistence write — coalesces rapid
 *  mutations (e.g. holding undo) into one IDB write instead of one per
 *  commit. Not about coalescing continuous input: every mutation in this
 *  app already only calls commit once, at the settled end-state (drag-end,
 *  not per-pointer-move), so this is purely about write frequency, not
 *  batching in-flight gestures. */
const SAVE_DEBOUNCE_MS = 500;

export function PodcastEditor() {
  const { tracks, addTrack, removeTrack, addFilesToTrack, isLoading } = useTimelineTracks();
  const { duplicateClip, deleteClip } = useClipActions();
  const { isProjectHydrating } = useProjectHydration();

  // Armed only once hydration completes — see the isProjectHydrating guard
  // below — so the project `useProjectHydration` just loaded doesn't
  // immediately re-trigger a redundant write back to the store it came from.
  // While hydrating, PodcastEditor renders only the loading placeholder (no
  // TimelineStage/EditorShell), so no user mutation can race replacePresent
  // either.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isProjectHydrating) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveProject(tracks).catch((err) => {
        console.error("[podcast-editor] Failed to save project to IndexedDB", err);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [tracks, isProjectHydrating]);

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

  // Same visual language as PodcastEditorLoader's own dynamic-import loading
  // state, for a consistent two-stage load (module load, then IDB load).
  if (isProjectHydrating) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Loading project…
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <TimelineStage
        onRemoveTrack={handleRemoveTrackByIndex}
        deferEngineRebuild={isLoading}
        onAddTrack={addTrack}
        onAddFilesToTrack={addFilesToTrack}
        onDuplicateClip={duplicateClip}
        onDeleteClip={deleteClip}
      />
    </div>
  );
}
