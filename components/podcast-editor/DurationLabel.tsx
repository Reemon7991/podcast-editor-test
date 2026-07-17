"use client";

import { usePlaylistData, usePlaylistControls } from "@waveform-playlist/browser";

/**
 * Separate from PlaybackTime so the low-frequency duration value (set once
 * when the track finishes loading) doesn't share a subscription with the
 * 60fps currentTime updates.
 */
export function DurationLabel() {
  const { duration } = usePlaylistData();
  const { formatTime } = usePlaylistControls();

  return (
    <span
      data-testid="total-duration"
      className="font-mono text-sm tabular-nums text-zinc-500 dark:text-zinc-400"
    >
      {formatTime(duration)}
    </span>
  );
}
