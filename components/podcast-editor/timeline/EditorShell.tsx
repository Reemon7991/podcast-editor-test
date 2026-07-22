"use client";

import { useEffect, useRef } from "react";
import { Waveform, usePlaylistData, usePlaylistControls } from "@waveform-playlist/browser";
import { TransportControls } from "../transport/TransportControls";
import { ClipDragLayer } from "./ClipDragLayer";

interface EditorShellProps {
  onRemoveTrack: (trackIndex: number) => void;
}

/**
 * Renders inside WaveformPlaylistProvider. Split out from AudioTrackLoader so
 * this subtree only mounts once the provider context actually exists.
 */
export function EditorShell({ onRemoveTrack }: EditorShellProps) {
  const { isReady } = usePlaylistData();
  const { scrollContainerRef } = usePlaylistControls();
  // Owned here (not inside PlayButton/ClipDragLayer) since both need it —
  // see the doc comments on transport/PlayButton.tsx and
  // timeline/ClipDragLayer.tsx for the play()/rebuild race this closes.
  const playPendingRef = useRef(false);

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
        <TransportControls playPendingRef={playPendingRef} />
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        {isReady ? (
          <ClipDragLayer playPendingRef={playPendingRef}>
            <Waveform showClipHeaders onRemoveTrack={onRemoveTrack} />
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
