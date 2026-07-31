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
  /** Optional — set on the trigger button as `data-clip-actions-for`
   *  (deliberately NOT `data-clip-id`: that attribute already means "this is
   *  the draggable clip element" throughout this app — SELECTORS.draggableClip
   *  in e2e/helpers.ts is `[data-clip-id]:not([data-boundary-edge])`, and
   *  reusing the same name on this button would make it match that selector
   *  too, silently doubling every "clip" count in the whole e2e suite —
   *  confirmed by hitting exactly that regression). Since
   *  ClipActionsOverlay.tsx now renders one persistent button per clip (not
   *  just one shared button for a hovered clip), plain accessible-name
   *  queries like `getByRole("button", { name: "Clip actions" })` are
   *  ambiguous once more than one clip exists; this gives callers (and e2e
   *  tests) a stable way to target a specific clip's button instead. Purely
   *  a DOM attribute — this component's own logic never reads it. */
  clipId?: string;
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
export function ClipActionsMenu({ actions, style, onOpenChange, clipId }: ClipActionsMenuProps) {
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
        data-clip-actions-for={clipId}
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
        // No resting background — the button is now always visible (not
        // just on hover) for every clip, so a permanent filled circle would
        // clutter every clip header at once. text color alone (a dark
        // purple, against the clip header's own light --accent-purple-100
        // tint) keeps it legible; the hover tint is just an affordance, not
        // a persistent fill.
        className="flex items-center justify-center rounded-full bg-transparent text-[var(--accent-purple-700)] hover:bg-[var(--accent-purple-700)]/10"
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
