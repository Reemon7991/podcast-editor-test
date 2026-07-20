"use client";

import { useRef, type ChangeEvent } from "react";
import type { ClipTrack } from "@waveform-playlist/browser";

interface TrackRowProps {
  track: ClipTrack;
  index: number;
  onAddFiles: (files: File[]) => void;
}

function TrackRow({ track, index, onAddFiles }: TrackRowProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) onAddFiles(files);
    event.target.value = "";
  };

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="truncate text-sm text-zinc-700 dark:text-zinc-300">
        {index + 1}. {track.name}
        <span className="ml-2 text-xs text-zinc-400">
          {track.clips.length} clip{track.clips.length === 1 ? "" : "s"}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="text-xs text-blue-600 hover:underline dark:text-blue-400"
        >
          Add clip
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={handleChange}
          className="hidden"
        />
      </div>
    </li>
  );
}

interface TrackListBarProps {
  tracks: ClipTrack[];
  onAddTrack: () => void;
  onAddFilesToTrack: (trackId: string, files: File[]) => void;
  gapSeconds: number;
  onGapSecondsChange: (value: number) => void;
}

/**
 * App-level panel for track/clip management. Mute/solo/volume/pan/track-name
 * editing and track selection are handled by WaveformPlaylistProvider's own
 * built-in per-track controls (enabled via `controls={{ show: true }}` on
 * TimelineStage) — this bar only covers what the library doesn't provide:
 * creating tracks and importing files onto a specific one.
 */
export function TrackListBar({
  tracks,
  onAddTrack,
  onAddFilesToTrack,
  gapSeconds,
  onGapSecondsChange,
}: TrackListBarProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={onAddTrack}
          className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800"
        >
          Add track
        </button>
        <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          Gap for new clips (s)
          <input
            type="number"
            min={0}
            step={0.1}
            value={gapSeconds}
            onChange={(e) =>
              onGapSecondsChange(Math.max(0, Number(e.target.value) || 0))
            }
            className="w-20 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      </div>

      <ul className="flex flex-col divide-y divide-zinc-200 rounded-md border border-zinc-200 text-sm dark:divide-zinc-800 dark:border-zinc-800">
        {tracks.map((track, index) => (
          <TrackRow
            key={track.id}
            track={track}
            index={index}
            onAddFiles={(files) => onAddFilesToTrack(track.id, files)}
          />
        ))}
      </ul>
    </div>
  );
}
