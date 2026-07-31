"use client";

import { useState, type ChangeEvent, type DragEvent, type RefObject } from "react";
import { usePlaybackAnimation } from "@waveform-playlist/browser";

interface AddClipsDropZoneProps {
  /** Same sticky ref TopBar's Upload button already reads (EditorShell.tsx
   *  owns it) — always the last non-null selected track. */
  activeTrackIdRef: RefObject<string | null>;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
}

/**
 * Single "drag and drop files here or click to upload" affordance, next to
 * "+ New Track" at the bottom of the track list — replaces an earlier
 * version that repeated this affordance once per empty track (cluttered,
 * and needed portaling into the scrollable timeline to position each one).
 * Lands new clips on `activeTrackIdRef.current` at the live playhead
 * position — same insertion rule as the top bar's own Upload button, so the
 * two "add files to the active track" entry points behave identically
 * regardless of which one is used.
 */
export function AddClipsDropZone({ activeTrackIdRef, onAddFilesToTrack }: AddClipsDropZoneProps) {
  const { currentTime } = usePlaybackAnimation();
  const [dragOver, setDragOver] = useState(false);
  const inputId = "add-clips-drop-zone-upload";

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    const trackId = activeTrackIdRef.current;
    if (trackId) onAddFilesToTrack(trackId, files, currentTime);
  };

  const handleDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files ?? []).filter((f) => f.type.startsWith("audio/")));
  };

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={`m-2 flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed text-sm transition-colors ${
        dragOver
          ? "border-[var(--accent-purple-500)] bg-[var(--accent-purple-50)] text-[var(--accent-purple-600)]"
          : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent-purple-300)] hover:text-[var(--accent-purple-600)]"
      }`}
    >
      <UploadCloudIcon />
      Drag and drop files here or click to upload
      <input
        id={inputId}
        type="file"
        accept="audio/*"
        multiple
        className="hidden"
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </label>
  );
}

function UploadCloudIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 16l-4-4-4 4" />
      <path d="M12 12v9" />
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    </svg>
  );
}
