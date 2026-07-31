"use client";

import { useState, type RefObject } from "react";
import {
  usePlaybackAnimation,
  usePlaylistControls,
  usePlaylistState,
} from "@waveform-playlist/browser";
import { Button } from "../ui/Button";

interface PlayPauseButtonProps {
  /** Threaded through exactly as the previous standalone PlayButton used it
   *  — see ClipDragLayer.tsx's/EditorShell.tsx's doc comments for the
   *  play()/engine-rebuild race this flag closes. Pause has no such race
   *  (synchronous library call), so it bypasses this guard entirely. */
  playPendingRef: RefObject<boolean>;
}

/**
 * Single toggling Play/Pause control — replaces the previous pair (our own
 * PlayButton + the library's own PauseButton). Play still goes through the
 * same race-guarded path the old PlayButton used; pause is a plain
 * synchronous usePlaylistControls().pause() call.
 */
export function PlayPauseButton({ playPendingRef }: PlayPauseButtonProps) {
  const { isPlaying, currentTimeRef } = usePlaybackAnimation();
  const { selectionStart, selectionEnd, isLoopEnabled } = usePlaylistState();
  const { play, pause } = usePlaylistControls();
  const [isPending, setIsPending] = useState(false);

  const handleClick = async () => {
    if (isPlaying) {
      pause();
      return;
    }
    playPendingRef.current = true;
    setIsPending(true);
    try {
      const hasSelection =
        selectionStart !== selectionEnd && selectionEnd > selectionStart;
      if (hasSelection && !isLoopEnabled) {
        await play(selectionStart, selectionEnd - selectionStart);
      } else {
        await play(currentTimeRef.current ?? 0);
      }
    } finally {
      playPendingRef.current = false;
      setIsPending(false);
    }
  };

  return (
    <Button
      variant="primary"
      onClick={handleClick}
      disabled={isPending}
      title={isPlaying ? "Pause" : "Play"}
      aria-label={isPlaying ? "Pause" : "Play"}
      className="h-11 w-11 !px-0"
    >
      {isPlaying ? <PauseIcon /> : <PlayIcon />}
    </Button>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="2.5" width="3" height="11" rx="1" />
      <rect x="9" y="2.5" width="3" height="11" rx="1" />
    </svg>
  );
}
