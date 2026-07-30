"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ClipSwapConfirmPopoverProps {
  anchor: { x: number; y: number };
  clipName?: string;
  neighborName?: string;
  onConfirm: () => void;
  onDecline: () => void;
}

const POPOVER_WIDTH = 220;

/**
 * Confirms a same-track clip swap/reorder. Fully controlled — mounted only
 * while a swap is pending, so it has no open/close state of its own, unlike
 * ClipActionsMenu (whose portal/positioning/dismissal pattern this mirrors).
 */
export function ClipSwapConfirmPopover({
  anchor,
  clipName,
  neighborName,
  onConfirm,
  onDecline,
}: ClipSwapConfirmPopoverProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.y + 12, left: anchor.x - POPOVER_WIDTH / 2 });

  useEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const height = containerRef.current?.offsetHeight ?? 90;
    const left = Math.max(4, Math.min(anchor.x - POPOVER_WIDTH / 2, vw - POPOVER_WIDTH - 4));
    let top = anchor.y + 12;
    if (top + height > vh - 4) {
      top = Math.max(4, anchor.y - height - 12);
    }
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      onDecline();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDecline();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onDecline]);

  return createPortal(
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Confirm clip reorder"
      onPointerDown={(e) => e.stopPropagation()}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: POPOVER_WIDTH, zIndex: 10000 }}
      className="rounded-md border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
    >
      <p className="mb-2 text-sm text-zinc-800 dark:text-zinc-100">
        Swap position with &ldquo;{neighborName ?? "this clip"}&rdquo;
        {clipName ? ` and move "${clipName}" there` : ""}?
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDecline}
          className="rounded px-2 py-1 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-zinc-900 px-2 py-1 text-sm text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          Swap
        </button>
      </div>
    </div>,
    document.body
  );
}
