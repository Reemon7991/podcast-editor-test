"use client";

import { useRef, type ChangeEvent, type RefObject } from "react";
import { PauseButton, ZoomInButton, ZoomOutButton, usePlaylistControls, usePlaybackAnimation, usePlaylistData } from "@waveform-playlist/browser";
import { PlayButton } from "./PlayButton";
import { PlaybackTime } from "./PlaybackTime";
import { DurationLabel } from "./DurationLabel";
import { UndoRedoButtons } from "./UndoRedoButtons";

interface TransportControlsProps {
  /** Threaded through to PlayButton — see its doc comment and
   *  ClipDragLayer's for the race this closes. */
  playPendingRef: RefObject<boolean>;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
  /** Sticky ref owned by EditorShell — always the last non-null selectedTrackId
   *  (defaulting to the first track). Passed as a ref rather than a value so
   *  handleUpload reads the live value at file-dialog-close time, not the
   *  (already-cleared) React render value at button-click time. */
  activeTrackIdRef: RefObject<string | null>;
}

/**
 * Transport bar. PauseButton/ZoomInButton/ZoomOutButton are the library's
 * own components — they read playback/zoom state directly from
 * WaveformPlaylistProvider's context, so no props need to be threaded for
 * them. PlayButton is our own replacement (see transport/PlayButton.tsx).
 */
export function TransportControls({ playPendingRef, onAddFilesToTrack, activeTrackIdRef }: TransportControlsProps) {
  const {} = usePlaylistControls();
  const { currentTime } = usePlaybackAnimation();
  const {} = usePlaylistData();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      const trackId = activeTrackIdRef.current;
      if (trackId) {
        onAddFilesToTrack(trackId, files, currentTime);
      } else {
        alert("Please add a track first.");
      }
    }
    event.target.value = "";
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center gap-1.5">
        <PlayButton playPendingRef={playPendingRef} />
        <PauseButton />
      </div>

      <div className="mx-1 h-5 w-px bg-zinc-300 dark:bg-zinc-700" />

      <div className="flex items-center gap-1.5">
        <UndoRedoButtons />
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

      <div className="ml-auto flex items-center">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-600 dark:hover:bg-blue-700"
        >
          Upload clip
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={handleUpload}
          className="hidden"
        />
      </div>
    </div>
  );
}
