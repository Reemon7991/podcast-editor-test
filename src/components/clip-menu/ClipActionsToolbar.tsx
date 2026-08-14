"use client";

import { Button } from "../ui/Button";
import { SplitIcon, DuplicateIcon, DeleteIcon, RemoveSilenceIcon } from "./ClipActionIcons";

export interface SelectedClip {
  trackId: string;
  clipId: string;
}

interface ClipActionsToolbarProps {
  selectedClip: SelectedClip | null;
  onSplit: () => void;
  onDuplicate: (trackId: string, clipId: string) => void;
  onDelete: (trackId: string, clipId: string) => void;
  /** Removes silence from the selected clip — resolving the actual clip
   *  object (not just its id) is EditorShell.tsx's job, same as it already
   *  is for ClipActionsOverlay's per-clip "..." menu. */
  onRemoveSilence: () => void;
  /** False when no clip is selected, or the selected clip has no audio to
   *  scan (a MIDI clip — see ClipActionsOverlay.tsx's own "audio-only
   *  feature" note; not reachable via this app's UI today, kept for parity). */
  canRemoveSilence: boolean;
  /** App-wide single-flight (useRemoveSilence.ts) — disables this button and
   *  swaps its tooltip even when a *different* clip is the one processing. */
  isRemovingSilence: boolean;
}

/**
 * Top-bar equivalent of ClipActionsOverlay's hover "…" menu — the same
 * actions (Split, Duplicate, Remove silence, Delete), reachable without
 * hovering the clip first. Disabled as a group until a clip is selected
 * (EditorShell.tsx's click-to-select listener sets `selectedClip`) — Remove
 * silence is additionally gated on `canRemoveSilence`/`isRemovingSilence`.
 * Split still arms the same "click a clip to choose the cut point" scissors
 * mode the hover menu uses — it isn't scoped to the selected clip
 * specifically, matching existing Split behavior exactly (see
 * EditorShell.tsx's shared `scissors`/`useClipSplitting` doc comment).
 *
 * "Generate clip (AI)" is deliberately not here: unlike these four, it
 * doesn't act on a selected clip (it inserts a new one), so it lives as its
 * own always-available icon button in TopBar.tsx instead — grouping it into
 * this selection-gated toolbar would incorrectly disable it whenever nothing
 * is selected.
 */
export function ClipActionsToolbar({
  selectedClip,
  onSplit,
  onDuplicate,
  onDelete,
  onRemoveSilence,
  canRemoveSilence,
  isRemovingSilence,
}: ClipActionsToolbarProps) {
  const disabled = !selectedClip;
  const removeSilenceTitle = isRemovingSilence ? "Removing silence…" : "Remove silence";

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
        disabled={!canRemoveSilence || isRemovingSilence}
        onClick={onRemoveSilence}
        title={removeSilenceTitle}
        aria-label={removeSilenceTitle}
      >
        <RemoveSilenceIcon />
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
