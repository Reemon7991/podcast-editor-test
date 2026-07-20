"use client";

import { Waveform, usePlaylistData } from "@waveform-playlist/browser";
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
        <TransportControls />
      </div>
      <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
        {isReady ? (
          <ClipDragLayer>
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
