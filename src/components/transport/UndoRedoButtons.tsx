"use client";

import { BaseControlButton } from "@waveform-playlist/ui-components";
import { useProjectStore, selectCanUndo, selectCanRedo } from "../../store/projectStore";

/**
 * No local stop()-if-playing guard needed — undo()/redo() themselves stop
 * playback first if needed (see projectStore.ts's `stopIfPlaying`/
 * `registerStopIfPlaying` doc comment), same as `commit`.
 */
export function UndoRedoButtons() {
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const canUndo = useProjectStore(selectCanUndo);
  const canRedo = useProjectStore(selectCanRedo);

  return (
    <>
      <BaseControlButton onClick={undo} disabled={!canUndo} title="Undo" aria-label="Undo">
        <UndoIcon />
      </BaseControlButton>
      <BaseControlButton onClick={redo} disabled={!canRedo} title="Redo" aria-label="Redo">
        <RedoIcon />
      </BaseControlButton>
    </>
  );
}

function UndoIcon() {
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
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function RedoIcon() {
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
      <polyline points="15 14 20 9 15 4" />
      <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    </svg>
  );
}
