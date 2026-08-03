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
import { TopBar } from "../layout/TopBar";
import { BottomBar } from "../transport/BottomBar";
import { ClipDragLayer } from "./ClipDragLayer";
import { ClipActionsOverlay } from "../clip-menu/ClipActionsOverlay";
import { AddClipsDropZone } from "./AddClipsDropZone";
import type { SelectedClip } from "../clip-menu/ClipActionsToolbar";
import { useScissorsSplit } from "../../hooks/useScissorsSplit";
import { resolveClipAt } from "../../utils/clipGeometry";
import { TRACK_ROW_HEIGHT_PX } from "../../utils/trackLayout";
import { useUndoRedoShortcut } from "../../hooks/useUndoRedoShortcut";
import { useProjectExport } from "../../hooks/useProjectExport";
import { registerStopIfPlaying } from "../../store/projectStore";

interface EditorShellProps {
  onRemoveTrack: (trackIndex: number) => void;
  onAddTrack: () => void;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
}

/**
 * Renders inside WaveformPlaylistProvider. Split out from AudioTrackLoader so
 * this subtree only mounts once the provider context actually exists.
 */
export function EditorShell({
  onRemoveTrack,
  onAddTrack,
  onAddFilesToTrack,
  onDuplicateClip,
  onDeleteClip,
}: EditorShellProps) {
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
  // same isReady/isExporting signals already gating TopBar/BottomBar below.
  useUndoRedoShortcut(isReady && !isExporting);

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

  return (
    <div className="flex flex-col gap-3">
      {/* Cross-track clip moves go through onTracksChange directly (see
       *  ClipDragLayer.tsx), which the provider can only apply via a full
       *  engine rebuild — dispose + rebuild the Tone.js engine for every
       *  track/clip. That's async and, for a large playlist, slow enough to
       *  click through: the library's own play() has a check-then-act race
       *  (init() awaited on the pre-rebuild engine, play() then fired on the
       *  post-rebuild one) that throws "TonePlayout not initialized" if Play
       *  is pressed mid-rebuild. isReady is the provider's own rebuild-done
       *  signal — gating the transport bar on it closes that window. */}
      <div
        data-testid="top-bar"
        className={isReady && !isExporting ? undefined : "pointer-events-none opacity-50"}
        aria-disabled={!isReady || isExporting}
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
          isReady && !isExporting ? "" : "pointer-events-none opacity-50"
        }`}
        aria-disabled={!isReady || isExporting}
      >
        <BottomBar playPendingRef={playPendingRef} />
      </div>
    </div>
  );
}
