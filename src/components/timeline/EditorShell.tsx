"use client";

import { useCallback, useEffect, useRef } from "react";
import { Waveform, usePlaylistData, usePlaylistControls, usePlaylistState } from "@waveform-playlist/browser";
import { TransportControls } from "../transport/TransportControls";
import { ClipDragLayer } from "./ClipDragLayer";
import { ClipActionsOverlay } from "../clip-menu/ClipActionsOverlay";
import { TRACK_ROW_HEIGHT_PX } from "../../utils/trackLayout";
import { useUndoRedoShortcut } from "../../hooks/useUndoRedoShortcut";

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
  const { isReady, tracks, timeScaleHeight } = usePlaylistData();
  const { selectedTrackId } = usePlaylistState();
  const { scrollContainerRef, setSelectedTrackId } = usePlaylistControls();
  // Owned here (not inside PlayButton/ClipDragLayer) since both need it —
  // see the doc comments on transport/PlayButton.tsx and
  // timeline/ClipDragLayer.tsx for the play()/rebuild race this closes.
  const playPendingRef = useRef(false);

  // Sticky ref: always holds the last known non-null selectedTrackId, defaulting
  // to the first track. This is immune to the browser clearing the library's
  // selectedTrackId when focus moves to the "Upload clip" button — the file
  // dialog's onChange fires after the blur, so reading selectedTrackId directly
  // there always sees null after the click.
  const activeTrackIdRef = useRef<string | null>(null);
  const effectiveTrackId = selectedTrackId ?? (tracks.length > 0 ? tracks[0].id : null);

  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z — see useUndoRedoShortcut.ts. Gated on the
  // same isReady signal already gating TransportControls below.
  useUndoRedoShortcut(isReady);

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
    },
    [timeScaleHeight, tracks, setSelectedTrackId]
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
        className={isReady ? undefined : "pointer-events-none opacity-50"}
        aria-disabled={!isReady}
      >
        <TransportControls
          playPendingRef={playPendingRef}
          onAddFilesToTrack={onAddFilesToTrack}
          activeTrackIdRef={activeTrackIdRef}
        />
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        {isReady ? (
          <ClipDragLayer playPendingRef={playPendingRef}>
            <div
              ref={waveformContainerRef}
              onPointerDown={handleWaveformPointerDown}
            >
              <Waveform showClipHeaders onRemoveTrack={onRemoveTrack} />
            </div>
            <ClipActionsOverlay onDuplicateClip={onDuplicateClip} onDeleteClip={onDeleteClip} />
            <div className="flex w-[180px] justify-center border-t border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900">
              <button
                type="button"
                onClick={onAddTrack}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700"
              >
                + New Track
              </button>
            </div>
          </ClipDragLayer>
        ) : (
          <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
            Building waveform…
          </div>
        )}
      </div>
    </div>
  );
}
