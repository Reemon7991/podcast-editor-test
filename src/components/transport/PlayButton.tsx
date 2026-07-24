"use client";

import { useState, type RefObject } from "react";
import { BaseControlButton } from "@waveform-playlist/ui-components";
import {
  usePlaybackAnimation,
  usePlaylistControls,
  usePlaylistState,
} from "@waveform-playlist/browser";

interface PlayButtonProps {
  playPendingRef: RefObject<boolean>;
}

/**
 * Replaces the library's own PlayButton so we can observe the async window
 * between pressing Play and its internal engine.init() resolving. The
 * library's play() (confirmed by reading @waveform-playlist/browser's dist
 * source) re-reads its engine ref after that await instead of using a
 * captured reference — if a clip drag commits mid-await and triggers an
 * engine rebuild, play() resumes against the new, uninitialized engine and
 * throws "TonePlayout not initialized". Not patchable from application code
 * (the race is inside bundled vendor output), so playPendingRef flags the
 * window instead, and ClipDragLayer's onDragEnd refuses to commit a move
 * while it's set. Selection/loop handling below mirrors the library's own
 * PlayButton exactly, so behavior is otherwise unchanged.
 */
export function PlayButton({ playPendingRef }: PlayButtonProps) {
  const { isPlaying, currentTimeRef } = usePlaybackAnimation();
  const { selectionStart, selectionEnd, isLoopEnabled } = usePlaylistState();
  const { play } = usePlaylistControls();
  const [isPending, setIsPending] = useState(false);

  const handleClick = async () => {
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
    <BaseControlButton onClick={handleClick} disabled={isPlaying || isPending}>
      Play
    </BaseControlButton>
  );
}
