"use client";

import { useEffect, useRef } from "react";
import { usePlaybackAnimation, usePlaylistControls } from "@waveform-playlist/browser";

/**
 * `currentTime` from usePlaybackAnimation() is a checkpoint value — it's only
 * set at play/pause/stop/seek boundaries, not every frame. The library's own
 * 60fps clock lives behind `registerFrameCallback`, updated via refs so it
 * doesn't force a React re-render on every tick. We hook into that directly
 * and write the formatted time straight into the DOM, so this component
 * never re-renders during playback at all — `currentTime` state is only used
 * for the initial/paused render.
 */
export function PlaybackTime() {
  const { currentTime, registerFrameCallback, unregisterFrameCallback } =
    usePlaybackAnimation();
  const { formatTime } = usePlaylistControls();
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const id = "playback-time-display";
    registerFrameCallback(id, ({ visualTime }) => {
      if (spanRef.current) {
        spanRef.current.textContent = formatTime(visualTime);
      }
    });
    return () => unregisterFrameCallback(id);
  }, [registerFrameCallback, unregisterFrameCallback, formatTime]);

  return (
    <span
      ref={spanRef}
      data-testid="current-time"
      className="font-mono text-sm tabular-nums text-zinc-700 dark:text-zinc-300"
    >
      {formatTime(currentTime)}
    </span>
  );
}
