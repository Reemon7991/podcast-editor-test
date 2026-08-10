"use client";

import { useEffect } from "react";

/**
 * Delete/Backspace deletes the currently selected clip (EditorShell.tsx's
 * click-to-select state) — same action as ClipActionsToolbar's Delete
 * button, just reachable without moving to the mouse.
 *
 * Ignored while focus is inside a text input/textarea/contentEditable
 * element (e.g. the "Generate clip (AI)" modal's textarea) — otherwise
 * Backspace while editing text there would delete a clip out from under the
 * user instead of just erasing a character.
 *
 * No stop()-if-playing guard needed here — onDelete (useClipActions.ts's
 * deleteClip) commits through the project store, which already stops
 * playback first if needed (see projectStore.ts's stopIfPlaying/
 * registerStopIfPlaying doc comment) — same reasoning ClipActionsToolbar's
 * own Delete button already relies on.
 */
export function useDeleteClipShortcut(
  enabled: boolean,
  selectedClip: { trackId: string; clipId: string } | null,
  onDelete: (trackId: string, clipId: string) => void
) {
  useEffect(() => {
    if (!enabled || !selectedClip) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
      onDelete(selectedClip.trackId, selectedClip.clipId);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, selectedClip, onDelete]);
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}
