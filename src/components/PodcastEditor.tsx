"use client";

import { useCallback, useEffect, useRef } from "react";
import { TimelineStage } from "./timeline/TimelineStage";
import { useTimelineTracks } from "../hooks/useTimelineTracks";
import { useClipActions } from "../hooks/useClipActions";
import { useProjectHydration } from "../hooks/useProjectHydration";
import { useProjectStore } from "../store/projectStore";
import { saveProject } from "../utils/persistence";
import { LoadingState } from "./ui/LoadingState";

/** Trailing-edge debounce for the persistence write — coalesces rapid
 *  mutations (e.g. holding undo) into one IDB write instead of one per
 *  commit. Not about coalescing continuous input: every mutation in this
 *  app already only calls commit once, at the settled end-state (drag-end,
 *  not per-pointer-move), so this is purely about write frequency, not
 *  batching in-flight gestures. */
const SAVE_DEBOUNCE_MS = 500;

export function PodcastEditor() {
  const {
    tracks,
    addTrack,
    removeTrack,
    addFilesToTrack,
    isLoading,
    saveWarning,
    dismissSaveWarning,
  } = useTimelineTracks();
  const { duplicateClip, deleteClip } = useClipActions();
  const { isProjectHydrating, hydrationWarning, dismissHydrationWarning } = useProjectHydration();

  // Keyed on `past` (undo history), not `present`/`tracks` directly. `past`
  // only changes on a real history-pushing commit (commit/commitEngineOutput/
  // undo/redo) — never on ClipDragLayer.tsx's updateEngineOutputLive, which
  // updates `present` on every pointer-move frame of a trim drag to drive the
  // live visual and deliberately never touches history (see
  // projectStore.ts's own doc comment). Keying on `tracks` instead used to
  // re-arm this effect on every one of those live-preview frames too — for a
  // small session harmless, but for this app's actual target (2-3 hour
  // podcasts, many tracks/clips) a trim drag paused for 500ms+ could trigger
  // a full-session IndexedDB write mid-gesture. Reading `present` fresh
  // inside the timeout (not the `tracks` closure) avoids depending on two
  // selectors staying in lockstep across renders.
  const past = useProjectStore((s) => s.past);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `isProjectHydrating` flipping false is itself a dependency change, so
  // without this guard the effect below re-runs (and arms a save) on the
  // very transition where it stops early-returning — writing the
  // just-loaded, unmodified project back to IndexedDB on every app load,
  // even one where the user never touched anything. Skips exactly that one
  // post-hydration occurrence; any later real `past` change still saves
  // normally.
  const skipNextSaveRef = useRef(true);
  useEffect(() => {
    if (isProjectHydrating) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveProject(useProjectStore.getState().present).catch((err) => {
        console.error("[podcast-editor] Failed to save project to IndexedDB", err);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [past, isProjectHydrating]);

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
    return <LoadingState message="Loading project…" />;
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {hydrationWarning && (
        <WarningBanner message={hydrationWarning} onDismiss={dismissHydrationWarning} />
      )}
      {saveWarning && <WarningBanner message={saveWarning} onDismiss={dismissSaveWarning} />}
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

/** Dismissible inline banner for persistence-degradation warnings (dropped
 *  clips on hydration, a failed asset save) — same "surface it in the UI,
 *  don't just console.warn" precedent as TimelineStage.tsx's providerError
 *  banner, amber rather than red since these are recoverable-this-session,
 *  not fatal. */
function WarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-amber-700 hover:text-amber-900"
      >
        ✕
      </button>
    </div>
  );
}
