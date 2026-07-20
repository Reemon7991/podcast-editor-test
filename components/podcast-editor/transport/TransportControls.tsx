"use client";

import type { RefObject } from "react";
import { PauseButton, ZoomInButton, ZoomOutButton } from "@waveform-playlist/browser";
import { PlayButton } from "./PlayButton";
import { PlaybackTime } from "./PlaybackTime";
import { DurationLabel } from "./DurationLabel";

interface TransportControlsProps {
  /** Threaded through to PlayButton — see its doc comment and
   *  ClipDragLayer's for the race this closes. */
  playPendingRef: RefObject<boolean>;
}

/**
 * Transport bar. PauseButton/ZoomInButton/ZoomOutButton are the library's
 * own components — they read playback/zoom state directly from
 * WaveformPlaylistProvider's context, so no props need to be threaded for
 * them. PlayButton is our own replacement (see transport/PlayButton.tsx).
 */
export function TransportControls({ playPendingRef }: TransportControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1.5">
        <PlayButton playPendingRef={playPendingRef} />
        <PauseButton />
      </div>

      <div className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />

      <div className="flex items-center gap-1.5">
        <ZoomOutButton />
        <ZoomInButton />
      </div>

      <div className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />

      <div className="flex items-center gap-1">
        <PlaybackTime />
        <span className="text-sm text-zinc-400">/</span>
        <DurationLabel />
      </div>
    </div>
  );
}
