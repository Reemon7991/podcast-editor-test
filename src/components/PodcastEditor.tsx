"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TimelineStage } from "./timeline/TimelineStage";
import { useTimelineTracks } from "../hooks/useTimelineTracks";
import { useClipActions } from "../hooks/useClipActions";
import { useProjectHydration } from "../hooks/useProjectHydration";
import { useProjectStore, withLiveMixerState } from "../store/projectStore";
import { saveProject } from "../utils/persistence";
import { LoadingState } from "./ui/LoadingState";
import { WarningBanner } from "./ui/WarningBanner";

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
  // post-hydration occurrence; any later real `past`/mixer change still
  // saves normally.
  const skipNextSaveRef = useRef(true);
  // Ref, not state — can't mutate `.current` during render either way (see
  // EditorShell.tsx's activeTrackIdRef).
  const isProjectHydratingRef = useRef(isProjectHydrating);
  useEffect(() => {
    isProjectHydratingRef.current = isProjectHydrating;
  }, [isProjectHydrating]);

  // Shared by both save triggers below. Reads isProjectHydrating from a ref
  // so this stays stable (no resubscribing the imperative listener below).
  const scheduleSave = useCallback(() => {
    if (isProjectHydratingRef.current) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      // Mixer edits don't touch `past` — merge live state in here too.
      const present = withLiveMixerState(useProjectStore.getState().present);
      saveProject(present).catch((err) => {
        console.error("[podcast-editor] Failed to save project to IndexedDB", err);
      });
    }, SAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    scheduleSave();
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [past, isProjectHydrating, scheduleSave]);

  // Re-arms the save timer on a mixer-only change (mute/solo/volume/pan
  // never touch `past`, see mixerTouchVersion's doc comment).
  //
  // Subscribed imperatively, NOT via the reactive `useProjectStore(s =>
  // s.mixerTouchVersion)` hook — that made PodcastEditor re-render on every
  // mixer tweak, which cascaded into TimelineStage.tsx (not memoized;
  // hydrate() always returns a new array reference) and forced an
  // unnecessary full engine rebuild on every click. Regressed
  // e2e/hydration.spec.ts's "adding a track does not rebuild" — confirmed
  // by reproducing it, not just reasoned about.
  useEffect(() => {
    let lastVersion = useProjectStore.getState().mixerTouchVersion;
    return useProjectStore.subscribe((state) => {
      if (state.mixerTouchVersion !== lastVersion) {
        lastVersion = state.mixerTouchVersion;
        scheduleSave();
      }
    });
  }, [scheduleSave]);

  // A podcast needs at least one track — the close button is hidden
  // entirely once only one remains (see the conditional onRemoveTrack prop
  // below), so this guard is a fallback for a stale-click race, not the
  // primary defense.
  const [deleteWarning, setDeleteWarning] = useState<string | null>(null);

  // WaveformPlaylistProvider's onRemoveTrack gives a track *index* (it's a
  // Waveform-level UI callback, not aware of our id-keyed state) — resolve it
  // back to a stable id before mutating state.
  const handleRemoveTrackByIndex = useCallback(
    (trackIndex: number) => {
      if (tracks.length <= 1) {
        setDeleteWarning("A podcast needs at least one track — this one can't be deleted.");
        return;
      }
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
      {deleteWarning && (
        <WarningBanner message={deleteWarning} onDismiss={() => setDeleteWarning(null)} />
      )}
      <TimelineStage
        // Hides every track's close button once only one track remains —
        // see handleRemoveTrackByIndex's doc comment.
        onRemoveTrack={tracks.length > 1 ? handleRemoveTrackByIndex : undefined}
        deferEngineRebuild={isLoading}
        isImportingClip={isLoading}
        onAddTrack={addTrack}
        onAddFilesToTrack={addFilesToTrack}
        onDuplicateClip={duplicateClip}
        onDeleteClip={deleteClip}
      />
    </div>
  );
}
