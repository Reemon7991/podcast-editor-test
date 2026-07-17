"use client";

import { Waveform, usePlaylistData } from "@waveform-playlist/browser";
import { TransportControls } from "./TransportControls";
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
      <TransportControls />
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
