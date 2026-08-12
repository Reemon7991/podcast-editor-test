"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Waveform,
  usePlaybackAnimation,
  usePlaylistData,
  usePlaylistControls,
  usePlaylistState,
  useClipSplitting,
} from "@waveform-playlist/browser";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/LoadingState";
import { WarningBanner } from "../ui/WarningBanner";
import { Toast } from "../ui/Toast";
import { TopBar } from "../layout/TopBar";
import { BottomBar } from "../transport/BottomBar";
import { ClipDragLayer } from "./ClipDragLayer";
import { ClipActionsOverlay } from "../clip-menu/ClipActionsOverlay";
import { AddClipsDropZone } from "./AddClipsDropZone";
import type { SelectedClip } from "../clip-menu/ClipActionsToolbar";
import { useScissorsSplit } from "../../hooks/useScissorsSplit";
import { useRemoveSilence } from "../../hooks/useRemoveSilence";
import { usePlayheadPagingScroll } from "../../hooks/usePlayheadPagingScroll";
import { resolveClipAt } from "../../utils/clipGeometry";
import { centerScrollOnTimeSeconds } from "../../utils/timelineScroll";
import { TRACK_ROW_HEIGHT_PX } from "../../utils/trackLayout";
import { useUndoRedoShortcut } from "../../hooks/useUndoRedoShortcut";
import { useDeleteClipShortcut } from "../../hooks/useDeleteClipShortcut";
import { useProjectExport } from "../../hooks/useProjectExport";
import { registerStopIfPlaying } from "../../store/projectStore";

interface EditorShellProps {
  /** Undefined hides every track's close button — see TimelineStageProps. */
  onRemoveTrack: ((trackIndex: number) => void) | undefined;
  /** True while a clip is decoding after an upload/drop — see
   *  TimelineStageProps' own doc comment. */
  isImportingClip: boolean;
  onAddTrack: () => void;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
}

/**
 * Renders inside WaveformPlaylistProvider. Split out from AudioTrackLoader so
 * this subtree only mounts once the provider context actually exists.
 *
 * useRemoveSilence() is called *here*, not lifted to PodcastEditor.tsx like
 * useClipActions/useTimelineTracks — deliberately. Its processingClipId/
 * toast state changes independently of any store commit() (it toggles
 * around an async detect/splice pipeline that may commit nothing at all,
 * e.g. "no silence detected"). TimelineStage.tsx sits *above* this
 * component and recomputes `hydrate(tracks)` fresh — a brand new array
 * reference, forcing a full engine rebuild — on *every* render where its
 * own passthrough cache is stale (true after any plain commit(), since
 * only commitEngineOutput populates it; see its own doc comment). A prop
 * threaded down through TimelineStage that changes on its own would make
 * TimelineStage re-render (and thus rebuild the engine) on every value
 * change, independent of whether anything on the timeline actually
 * changed — confirmed by instrumenting commit()/commitEngineOutput()
 * directly and observing an extra "waveform-playlist:ready" dispatch with
 * neither ever firing. Keeping this hook (and its toast/overlay) entirely
 * below TimelineStage means its state changes only re-render this
 * subtree, never TimelineStage itself.
 */
export function EditorShell({
  onRemoveTrack,
  isImportingClip,
  onAddTrack,
  onAddFilesToTrack,
  onDuplicateClip,
  onDeleteClip,
}: EditorShellProps) {
  const {
    removeSilence,
    processingClipId,
    toast: silenceToast,
    dismissToast: dismissSilenceToast,
    saveWarning: silenceSaveWarning,
    dismissSaveWarning: dismissSilenceSaveWarning,
  } = useRemoveSilence();
  const isRemovingSilence = processingClipId !== null;
  const { isReady, tracks, trackStates, timeScaleHeight, samplesPerPixel, sampleRate, playoutRef } =
    usePlaylistData();
  const { selectedTrackId } = usePlaylistState();
  const { scrollContainerRef, setSelectedTrackId, stop } = usePlaylistControls();
  const { isPlaying } = usePlaybackAnimation();
  // Owned here (not inside PlayButton/ClipDragLayer) since both need it —
  // see the doc comments on transport/PlayButton.tsx and
  // timeline/ClipDragLayer.tsx for the play()/rebuild race this closes.
  const playPendingRef = useRef(false);

  // Owned here so the "disable transport while busy" guard below can also
  // cover export (an offline render temporarily swaps Tone's global context).
  const { exportProject, isExporting, error: exportError } = useProjectExport(tracks, trackStates);

  // Single shared instance for BOTH ClipActionsOverlay's hover "…" menu and
  // the top-bar ClipActionsToolbar's Split button — lifted here (their
  // nearest common parent) instead of each owning its own copy, so there's
  // exactly one scissors-mode state instead of two that could desync (see
  // ClipActionsOverlay.tsx's own doc comment on these props). scrollEl
  // mirrors scrollContainerRef.current as reactive state (the ref alone
  // can't be read during render — same reasoning EditorShell's own
  // scroll-restore effect below already relies on).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setScrollEl(scrollContainerRef.current);
  }, [isReady, scrollContainerRef]);
  const { splitClipAt } = useClipSplitting({ tracks, samplesPerPixel, engineRef: playoutRef });
  const scissors = useScissorsSplit({
    scrollContainerRef,
    scrollEl,
    tracks,
    samplesPerPixel,
    timeScaleHeight,
    sampleRate,
    splitClipAt,
  });

  // Clip explicitly selected via click (distinct from `selectedTrackId`
  // above, which is whole-track selection from the library). Stores only
  // ids, not indices — indices shift on reorder/undo, ids don't, and every
  // consumer (ClipActionsOverlay's ring, ClipActionsToolbar) re-resolves the
  // live clip from `tracks` by id anyway.
  const [selectedClipRaw, setSelectedClip] = useState<SelectedClip | null>(null);
  // Derived, not effect-synced: if the selected clip no longer exists after
  // any mutation (delete, undo, drag, split), this recomputes to null on its
  // own the next render — no separate "clear stale selection" effect needed.
  const selectedClip =
    selectedClipRaw &&
    tracks.some(
      (t) => t.id === selectedClipRaw.trackId && t.clips.some((c) => c.id === selectedClipRaw.clipId)
    )
      ? selectedClipRaw
      : null;

  // Resolves `selectedClip`'s ids to the actual track/clip objects — needed
  // for the top-bar "Remove silence" button below, since removeSilence()
  // (useRemoveSilence.ts) takes a real AudioClip, not just an id. Re-resolved
  // fresh every render from the live `tracks` array (same approach
  // ClipActionsOverlay.tsx already uses for its own selection ring), so it
  // can't go stale across a drag/undo/split the way a cached reference could.
  const selectedTrackForToolbar = selectedClip
    ? tracks.find((t) => t.id === selectedClip.trackId)
    : undefined;
  const selectedClipForToolbar = selectedTrackForToolbar?.clips.find(
    (c) => c.id === selectedClip?.clipId
  );
  // Audio-only feature — MIDI clips have nothing for it to act on, same
  // guard ClipActionsOverlay.tsx's per-clip menu already applies. Not
  // reachable via this app's UI today (no MIDI import path exists), kept for
  // parity with that guard rather than assuming it can never matter.
  const canRemoveSilenceSelected = !!selectedClipForToolbar && !selectedClipForToolbar.midiNotes;
  const handleRemoveSilenceSelected = () => {
    if (selectedTrackForToolbar && selectedClipForToolbar) {
      removeSilence(selectedTrackForToolbar.id, selectedClipForToolbar);
    }
  };

  // Registers this provider's actual stop()/isPlaying with the project store
  // (see projectStore.ts's own doc comment on stopIfPlaying/
  // registerStopIfPlaying) so `commit`/`undo`/`redo` — called from outside
  // this provider's context, e.g. useTimelineTracks.ts's addFilesToTrack
  // after an async decode — can still stop playback before a rebuild-forcing
  // mutation, without every call site needing its own guard. Kept fresh
  // every render (no dep array), same as the sticky-ref pattern below.
  // flushSync (not a plain call) is required for the same reason as
  // ClipDragLayer.tsx's onDragEnd — see its doc comment for the full trace of
  // why a plain stop() isn't enough once tracks flows through the Zustand
  // store.
  useEffect(() => {
    registerStopIfPlaying(() => {
      if (isPlaying) flushSync(() => stop());
    });
  });

  // Sticky ref: always holds the last known non-null selectedTrackId, defaulting
  // to the first track. This is immune to the browser clearing the library's
  // selectedTrackId when focus moves to the "Upload clip" button — the file
  // dialog's onChange fires after the blur, so reading selectedTrackId directly
  // there always sees null after the click.
  const activeTrackIdRef = useRef<string | null>(null);
  const effectiveTrackId = selectedTrackId ?? (tracks.length > 0 ? tracks[0].id : null);

  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z — see useUndoRedoShortcut.ts. Gated on the
  // same isReady/isExporting/isRemovingSilence/isImportingClip signals
  // already gating TopBar/BottomBar below.
  const editorBusy = !isReady || isExporting || isRemovingSilence || isImportingClip;
  useUndoRedoShortcut(!editorBusy);
  // Delete/Backspace deletes the selected clip — see useDeleteClipShortcut.ts.
  useDeleteClipShortcut(!editorBusy, selectedClip, onDeleteClip);

  // Ref updates must happen outside render (React disallows mutating a ref's
  // `.current` during render).
  useEffect(() => {
    if (effectiveTrackId !== null) {
      activeTrackIdRef.current = effectiveTrackId;
    }
  }, [effectiveTrackId]);

  // The library's built-in track controls never call setSelectedTrackId when
  // the user clicks a track — so selectedTrackId stays null permanently unless
  // we detect the click ourselves. We intercept pointerdown on the waveform
  // container, subtract the timescale row, divide by TRACK_ROW_HEIGHT_PX to
  // get the row index, and call setSelectedTrackId manually.
  //
  // Also resolves clip-level selection (`selectedClip`, ClipActionsOverlay's
  // ring/ClipActionsToolbar) in the same handler — this used to be a second,
  // separate mousedown listener attached imperatively to scrollEl, doing its
  // own overlapping X/Y math via resolveClipAt. One handler, one event, one
  // coordinate pass is simpler and avoids two different attachment styles
  // (React prop vs addEventListener) doing the same kind of work. Clip
  // resolution only applies within the scrollable waveform area (clips never
  // render in the left controls column), and needs scrollEl's own rect/
  // scrollLeft — not this container's — for resolveClipAt's content-space
  // math to be correct, so it's skipped (not resolved against the wrong
  // container) for controls-panel clicks or before scrollEl exists.
  const waveformContainerRef = useRef<HTMLDivElement>(null);
  const handleWaveformPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const container = waveformContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const relativeY = e.clientY - rect.top;
      const relativeX = e.clientX - rect.left;

      // The left controls panel (width=180) has no timescale header at the top —
      // the timescale ruler only exists in the right scrollable waveform area.
      // Subtracting timeScaleHeight for left-panel clicks shifts everything up
      // by that amount and mis-identifies the track (e.g. Track 2 → Track 1).
      const isInControlsPanel = relativeX < 180; // matches controls={{ width: 180 }}
      const trackAreaY = isInControlsPanel ? relativeY : relativeY - timeScaleHeight;

      if (trackAreaY < 0) return; // click on timescale ruler (right panel only)
      const trackIndex = Math.floor(trackAreaY / TRACK_ROW_HEIGHT_PX);
      const clampedIndex = Math.min(Math.max(trackIndex, 0), tracks.length - 1);
      const clickedTrack = tracks[clampedIndex];
      if (clickedTrack) {
        setSelectedTrackId(clickedTrack.id);
      }

      if (!isInControlsPanel && scrollEl) {
        const hit = resolveClipAt(e.clientX, e.clientY, scrollEl, tracks, samplesPerPixel, timeScaleHeight);
        const hitClip = hit ? tracks[hit.trackIndex]?.clips[hit.clipIndex] : undefined;
        const hitTrack = hit ? tracks[hit.trackIndex] : undefined;
        setSelectedClip(hitTrack && hitClip ? { trackId: hitTrack.id, clipId: hitClip.id } : null);
      }
    },
    [timeScaleHeight, tracks, setSelectedTrackId, scrollEl, samplesPerPixel]
  );

  // Every accepted clip move triggers a full engine rebuild (isReady flips
  // false then true), which tears down and remounts <Waveform> below.
  // attempted to keep it permanently mounted instead, but that caused another bug.
  // So: remount stays, and scroll position is preserved around it manually: track it continuously while
  // a container exists, restore it once the next one mounts.
  const savedScrollLeftRef = useRef(0);
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      savedScrollLeftRef.current = container.scrollLeft;
    };
    container.addEventListener("scroll", onScroll);
    return () => container.removeEventListener("scroll", onScroll);
  }, [isReady, scrollContainerRef]);

  // Restores on every render (not just the isReady false->true transition)
  // rather than a single one-shot effect — cheap, and avoids depending on
  // exactly which render the new container first appears on.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (isReady && container && container.scrollLeft !== savedScrollLeftRef.current) {
      container.scrollLeft = savedScrollLeftRef.current;
    }
  });

  // Jumps the timeline to center on `seconds` — used by SearchButton.tsx's
  // result click. usePlaylistControls().seekTo() alone only moves the
  // playhead's own currentTime; nothing scrolls to reveal it — a plain seek
  // while paused is a separate gap from playback's own follow-scroll (below)
  // and this library has no built-in handling for it at all, confirmed by
  // reading its dist source. See utils/timelineScroll.ts's own doc comment
  // for the full trace.
  //
  // savedScrollLeftRef is updated here too, synchronously, right alongside
  // the jump — not left to the container's own "scroll" event listener
  // above, which only updates it *asynchronously*. Without this, the
  // restore effect just above (which runs on every render, including the
  // one setSelectedClip triggers right after this) could read a still-stale
  // savedScrollLeftRef and immediately snap this jump back to wherever the
  // timeline happened to be scrolled before it.
  const handleScrollToTime = useCallback(
    (seconds: number) => {
      const container = scrollContainerRef.current;
      if (!container) return;
      centerScrollOnTimeSeconds(container, seconds, sampleRate, samplesPerPixel);
      savedScrollLeftRef.current = container.scrollLeft;
    },
    [scrollContainerRef, sampleRate, samplesPerPixel]
  );

  // Pages the timeline forward once the playhead reaches the right edge
  // during playback, landing it back at the left — see
  // hooks/usePlayheadPagingScroll.ts's own doc comment for why this exists
  // instead of the library's own automaticScroll prop (continuous
  // recentering, reverted after direct user feedback that it fought manual
  // scrolling during playback). onPaged mirrors handleScrollToTime's own
  // synchronous savedScrollLeftRef update, for the same reason.
  usePlayheadPagingScroll({
    scrollContainerRef,
    isPlaying,
    onPaged: (newScrollLeft) => {
      savedScrollLeftRef.current = newScrollLeft;
    },
  });

  return (
    <div className="flex flex-col gap-3">
      {silenceSaveWarning && (
        <WarningBanner message={silenceSaveWarning} onDismiss={dismissSilenceSaveWarning} />
      )}
      {silenceToast && <Toast message={silenceToast} onDismiss={dismissSilenceToast} />}
      {/* Cross-track clip moves go through onTracksChange directly (see
       *  ClipDragLayer.tsx), which the provider can only apply via a full
       *  engine rebuild — dispose + rebuild the Tone.js engine for every
       *  track/clip. That's async and, for a large playlist, slow enough to
       *  click through: the library's own play() has a check-then-act race
       *  (init() awaited on the pre-rebuild engine, play() then fired on the
       *  post-rebuild one) that throws "TonePlayout not initialized" if Play
       *  is pressed mid-rebuild. isReady is the provider's own rebuild-done
       *  signal — gating the transport bar on it closes that window. Also
       *  gated on isRemovingSilence/isImportingClip, same treatment as
       *  isExporting — see the editing overlays below. */}
      <div
        data-testid="top-bar"
        className={editorBusy ? "pointer-events-none opacity-50" : undefined}
        aria-disabled={editorBusy}
      >
        <TopBar
          onAddFilesToTrack={onAddFilesToTrack}
          activeTrackIdRef={activeTrackIdRef}
          exportProject={exportProject}
          isExporting={isExporting}
          exportError={exportError}
          selectedClip={selectedClip}
          onSplitSelected={scissors.activate}
          onDuplicateClip={onDuplicateClip}
          onDeleteClip={onDeleteClip}
          onRemoveSilenceSelected={handleRemoveSilenceSelected}
          canRemoveSilenceSelected={canRemoveSilenceSelected}
          isRemovingSilence={isRemovingSilence}
          onSelectClip={setSelectedClip}
          onScrollToTime={handleScrollToTime}
        />
      </div>
      <div className="relative overflow-hidden rounded-xl border border-[var(--border)]">
        {isReady ? (
          <ClipDragLayer playPendingRef={playPendingRef}>
            <div
              ref={waveformContainerRef}
              onPointerDown={handleWaveformPointerDown}
            >
              <Waveform showClipHeaders showFades onRemoveTrack={onRemoveTrack} />
            </div>
            <ClipActionsOverlay
              onDuplicateClip={onDuplicateClip}
              onDeleteClip={onDeleteClip}
              onRemoveSilence={removeSilence}
              processingClipId={processingClipId}
              playPendingRef={playPendingRef}
              scrollEl={scrollEl}
              scissors={scissors}
              selectedClip={selectedClip}
            />
            <div className="flex border-t border-[var(--border)] bg-[var(--surface)]">
              <div className="flex w-[180px] shrink-0 justify-center p-2">
                <Button variant="secondary" onClick={onAddTrack} className="w-full">
                  + New Track
                </Button>
              </div>
              <AddClipsDropZone activeTrackIdRef={activeTrackIdRef} onAddFilesToTrack={onAddFilesToTrack} />
            </div>
          </ClipDragLayer>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <LoadingState message="Building waveform…" bare />
          </div>
        )}
        {/* Blocks editing during export */}
        {isExporting && (
          <div
            data-testid="export-overlay"
            className="absolute inset-0 z-[500] flex items-center justify-center bg-white/80"
          >
            <LoadingState message="Exporting…" />
          </div>
        )}
        {/* Blocks editing while silence removal is in flight — same
         *  full-editor treatment as export above, requested over the
         *  original narrower "only disable this clip's own menu item"
         *  design: simpler to reason about, and matches the one other
         *  async, potentially-slow mutation this app already has. */}
        {isRemovingSilence && (
          <div
            data-testid="silence-removal-overlay"
            className="absolute inset-0 z-[500] flex items-center justify-center bg-white/80"
          >
            <LoadingState message="Removing silence…" />
          </div>
        )}
        {/* Blocks editing while an uploaded/dropped clip is still decoding —
         *  same full-editor treatment as export/silence removal above, so a
         *  large file doesn't leave the user waiting with no indication
         *  anything is happening. */}
        {isImportingClip && (
          <div
            data-testid="clip-import-overlay"
            className="absolute inset-0 z-[500] flex items-center justify-center bg-white/80"
          >
            <LoadingState message="Loading new clip…" />
          </div>
        )}
      </div>
      {/* Fixed to the viewport, not the page's own scroll — so play/pause
       *  (and the rest of the transport controls) always stays reachable
       *  without scrolling down, even on a long multi-track session.
       *  app/page.tsx reserves matching bottom padding so this never covers
       *  the last track/footer row. z-[200]: comfortably above the vendor's
       *  own highest internal z-index (its sticky controls column at 101,
       *  above its own playhead at 100, per @waveform-playlist/browser's
       *  source) — without this, a tall/scrolled session could show the
       *  playhead line drawing over this fixed bar instead of stopping
       *  behind it, since a merely-higher-than-default z-index (e.g.
       *  Tailwind's z-40) still loses to those. */}
      <div
        data-testid="transport-bar"
        className={`fixed inset-x-0 bottom-0 z-[200] px-6 pb-4 ${
          editorBusy ? "pointer-events-none opacity-50" : ""
        }`}
        aria-disabled={editorBusy}
      >
        <BottomBar playPendingRef={playPendingRef} />
      </div>
    </div>
  );
}
