"use client";

import { useRef, type ChangeEvent, type RefObject } from "react";
import { usePlaybackAnimation } from "@waveform-playlist/browser";
import { Button } from "../ui/Button";
import { UndoRedoButtons } from "../transport/UndoRedoButtons";
import { ClipActionsToolbar, type SelectedClip } from "../clip-menu/ClipActionsToolbar";

interface TopBarProps {
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
  /** Sticky ref owned by EditorShell — see TransportControls' previous doc
   *  comment on why this must be a ref, not a plain value. */
  activeTrackIdRef: RefObject<string | null>;
  exportProject: () => Promise<unknown>;
  isExporting: boolean;
  exportError: string | null;
  selectedClip: SelectedClip | null;
  onSplitSelected: () => void;
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
}

/**
 * Top toolbar: project label + Undo/Redo (left) — Split/Duplicate/Delete
 * clip actions, disabled until a clip is selected (center) — Upload/Export
 * (right). Replaces the old single TransportControls bar's upload/export
 * responsibility; playback/zoom now live in BottomBar.tsx instead.
 */
export function TopBar({
  onAddFilesToTrack,
  activeTrackIdRef,
  exportProject,
  isExporting,
  exportError,
  selectedClip,
  onSplitSelected,
  onDuplicateClip,
  onDeleteClip,
}: TopBarProps) {
  const { currentTime } = usePlaybackAnimation();
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
    <div className="flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-white px-4 py-2 shadow-sm">
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-sm font-semibold text-[var(--foreground)]">Podcast Editor</span>
        <div className="h-5 w-px bg-[var(--border)]" />
        <UndoRedoButtons />
      </div>

      <div className="flex flex-1 items-center justify-center">
        <ClipActionsToolbar
          selectedClip={selectedClip}
          onSplit={onSplitSelected}
          onDuplicate={onDuplicateClip}
          onDelete={onDeleteClip}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {exportError && <span className="text-xs text-red-600">{exportError}</span>}
        <Button variant="secondary" icon={<UploadIcon />} onClick={() => inputRef.current?.click()}>
          Upload clip
        </Button>
        <Button
          variant="primary"
          icon={<ExportIcon />}
          onClick={() => {
            exportProject().catch(() => {
              // error is already surfaced via exportError above
            });
          }}
          disabled={isExporting}
        >
          {isExporting ? "Exporting…" : "Export"}
        </Button>
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

function UploadIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
