"use client";

import { useRef, useState, type ChangeEvent, type RefObject } from "react";
import { usePlaybackAnimation } from "@waveform-playlist/browser";
import { Button } from "../ui/Button";
import { UndoRedoButtons } from "../transport/UndoRedoButtons";
import { ClipActionsToolbar, type SelectedClip } from "../clip-menu/ClipActionsToolbar";
import { MenuButton } from "../ui/MenuButton";
import { GenerateSpeechModal } from "../tts/GenerateSpeechModal";

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
  // null distinguishes "closed" from "open" — captured from activeTrackIdRef
  // at the moment "Generate clip (AI)" is clicked (an event handler, not
  // render), same as handleUpload already reads the ref. Reading
  // activeTrackIdRef.current directly during render is not an option here:
  // this project's eslint-plugin-react-hooks config rejects reading a ref's
  // `.current` during render, not just writing it (see CLAUDE.md's Phase 1
  // notes on this exact rule).
  const [generateModalState, setGenerateModalState] = useState<{ trackId: string | null } | null>(
    null
  );

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
        <MenuButton
          label=" Clip"
          icon={<PlusIcon />}
          minWidth={200}
          actions={[
            {
              id: "upload-clip-file",
              label: "Upload clip file",
              icon: <UploadIcon />,
              onSelect: () => inputRef.current?.click(),
            },
            {
              id: "generate-clip-ai",
              label: "Generate clip (AI)",
              icon: <SparkleIcon />,
              onSelect: () => setGenerateModalState({ trackId: activeTrackIdRef.current }),
            },
          ]}
        />
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
      {generateModalState && (
        <GenerateSpeechModal
          trackId={generateModalState.trackId}
          insertionTimeSeconds={currentTime}
          onClose={() => setGenerateModalState(null)}
        />
      )}
    </div>
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


/** "+ Clip" trigger icon. */
function PlusIcon() {
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
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** "Upload clip file" menu item icon — same arrow-into-tray shape the old
 *  standalone "Upload clip" button used before it moved into this dropdown. */
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

/** "Generate clip (AI)" menu item icon — a filled sparkle, the standard
 *  "AI/generate" glyph. Deliberately filled rather than stroked (the only
 *  filled icon in this file): a thin-stroke 4-point star reads poorly at
 *  14px, and a solid accent for the one AI-powered action here is a common,
 *  intentional differentiation (seen in most AI-feature iconography) rather
 *  than an inconsistency — same currentColor scheme as every other icon,
 *  no new color introduced. */
function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2 L14 10 L22 12 L14 14 L12 22 L10 14 L2 12 L10 10 Z" />
    </svg>
  );
}
