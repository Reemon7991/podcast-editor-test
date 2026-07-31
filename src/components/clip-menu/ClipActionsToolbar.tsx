"use client";

import { Button } from "../ui/Button";

export interface SelectedClip {
  trackId: string;
  clipId: string;
}

interface ClipActionsToolbarProps {
  selectedClip: SelectedClip | null;
  onSplit: () => void;
  onDuplicate: (trackId: string, clipId: string) => void;
  onDelete: (trackId: string, clipId: string) => void;
}

/**
 * Top-bar equivalent of ClipActionsOverlay's hover "…" menu — the same three
 * actions (Split, Duplicate, Delete), reachable without hovering the clip
 * first. Disabled as a group until a clip is selected (EditorShell.tsx's
 * click-to-select listener sets `selectedClip`). Split still arms the same
 * "click a clip to choose the cut point" scissors mode the hover menu uses —
 * it isn't scoped to the selected clip specifically, matching existing Split
 * behavior exactly (see EditorShell.tsx's shared `scissors`/`useClipSplitting`
 * doc comment).
 */
export function ClipActionsToolbar({
  selectedClip,
  onSplit,
  onDuplicate,
  onDelete,
}: ClipActionsToolbarProps) {
  const disabled = !selectedClip;

  return (
    <div className="flex items-center gap-1">
      <Button variant="icon" disabled={disabled} onClick={onSplit} title="Split" aria-label="Split">
        <SplitIcon />
      </Button>
      <Button
        variant="icon"
        disabled={disabled}
        onClick={() => selectedClip && onDuplicate(selectedClip.trackId, selectedClip.clipId)}
        title="Duplicate"
        aria-label="Duplicate"
      >
        <DuplicateIcon />
      </Button>
      <Button
        variant="icon"
        disabled={disabled}
        onClick={() => selectedClip && onDelete(selectedClip.trackId, selectedClip.clipId)}
        title="Delete"
        aria-label="Delete"
        className="hover:!text-red-600"
      >
        <DeleteIcon />
      </Button>
    </div>
  );
}

function SplitIcon() {
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
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

function DuplicateIcon() {
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
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function DeleteIcon() {
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
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
