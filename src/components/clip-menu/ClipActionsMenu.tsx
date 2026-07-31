"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export interface ClipMenuAction {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Styles the item as a destructive action (e.g. "Delete"). */
  destructive?: boolean;
}

interface ClipActionsMenuProps {
  actions: ClipMenuAction[];
  /** Absolute position (within the nearest positioned ancestor) for the
   *  trigger button — the caller owns all clip/track layout math, this
   *  component only owns the menu's own open/close/positioning behavior. */
  style: CSSProperties;
  /** Fires whenever the dropdown opens or closes. Lets a positioning parent
   *  (e.g. ClipActionsOverlay) keep this component mounted — and therefore
   *  its menu open — even after the pointer that revealed it moves away. */
  onOpenChange?: (open: boolean) => void;
}

const DROPDOWN_MIN_WIDTH = 160;

/**
 * Generic "..." trigger + dropdown menu — not clip-specific in its own
 * logic (only `ClipActionsOverlay`'s usage makes it clip-related), so future
 * per-clip or per-track menus can reuse it directly by supplying different
 * `actions`. Deliberately reimplements (rather than reuses)
 * `@waveform-playlist/ui-components`'s own `TrackMenu`: that component is
 * uncontrolled with no way to observe its open state from outside, which
 * this needs (see `onOpenChange` above) to stay open while the pointer
 * leaves the clip that revealed it. The positioning approach (fixed,
 * measured from the trigger's own `getBoundingClientRect`, portaled to
 * `document.body`, clamped to the viewport) mirrors `TrackMenu`'s, since
 * that part is already proven to work well here.
 */
export function ClipActionsMenu({ actions, style, onOpenChange }: ClipActionsMenuProps) {
  const [open, setOpenState] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange]
  );

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dropHeight = dropdownRef.current?.offsetHeight ?? 140;

    let left = rect.right - DROPDOWN_MIN_WIDTH;
    left = Math.max(4, Math.min(left, vw - DROPDOWN_MIN_WIDTH - 4));

    let top = rect.bottom + 4;
    if (top + dropHeight > vh - 4) {
      top = Math.max(4, rect.top - dropHeight - 4);
    }
    setDropdownPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const raf = requestAnimationFrame(updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, setOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Clip actions"
        aria-label="Clip actions"
        aria-haspopup="menu"
        aria-expanded={open}
        // Both stopped: mousedown would otherwise seek the playhead via the
        // library's ClickOverlay underneath (see ClipActionsOverlay), and
        // click would otherwise re-trigger whatever this button's parent
        // stacking context sits above.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        style={style}
        className="flex items-center justify-center rounded-full bg-[var(--accent-purple-700)]/80 text-white hover:bg-[var(--accent-purple-700)]"
      >
        <DotsIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "fixed", top: dropdownPos.top, left: dropdownPos.left, zIndex: 10000 }}
            className="min-w-[160px] overflow-hidden rounded-xl border border-[var(--border)] bg-white py-1 shadow-lg"
          >
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  action.onSelect();
                  setOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                  action.destructive
                    ? "text-red-600 hover:bg-red-50"
                    : "text-[var(--foreground)] hover:bg-[var(--accent-purple-50)]"
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

function DotsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}
