"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/Button";

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
      className="rounded-xl border border-[var(--border)] bg-white p-3 shadow-lg"
    >
      <p className="mb-2 text-sm text-[var(--foreground)]">
        Swap position with &ldquo;{neighborName ?? "this clip"}&rdquo;
        {clipName ? ` and move "${clipName}" there` : ""}?
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDecline}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={onConfirm}>
          Swap
        </Button>
      </div>
    </div>,
    document.body
  );
}
