"use client";

import {
  PlayButton,
  PauseButton,
  ZoomInButton,
  ZoomOutButton,
} from "@waveform-playlist/browser";
import { PlaybackTime } from "./PlaybackTime";
import { DurationLabel } from "./DurationLabel";

/**
 * Transport bar. PlayButton/PauseButton/ZoomInButton/ZoomOutButton are the
 * library's own components — they read playback/zoom state directly from
 * WaveformPlaylistProvider's context, so no props need to be threaded here.
 */
export function TransportControls() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1.5">
        <PlayButton />
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
