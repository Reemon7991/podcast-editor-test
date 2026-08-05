"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

export interface MenuButtonAction {
  id: string;
  label: string;
  onSelect: () => void;
  /** Optional — rendered left of the label when supplied, omitted entirely
   *  otherwise (mixing icon and icon-less actions in the same menu is fine;
   *  each item lays itself out independently). */
  icon?: ReactNode;
}

interface MenuButtonProps {
  label: string;
  actions: MenuButtonAction[];
  /** Optional — forwarded to the trigger `Button`'s own `icon` prop. Omitted
   *  entirely renders the plain text-only trigger (e.g. "+ New Track"'s
   *  existing style). */
  icon?: ReactNode;
  /** Widens the dropdown past its default 160px — set this to fit whatever
   *  the caller's own labels need (e.g. TopBar.tsx's "+ Clip" menu, whose
   *  "Generate clip (AI)" label is longer than this component's default
   *  assumes). Per-instance sizing tailored to actual content is already
   *  this app's pattern, not an inconsistency: ClipSwapConfirmPopover.tsx
   *  sizes itself independently too, and ClipActionsMenu.tsx's own dropdown
   *  is sized for its own (shorter) "Split"/"Duplicate"/"Delete" labels. */
  minWidth?: number;
}

const DEFAULT_DROPDOWN_MIN_WIDTH = 160;

/**
 * A labeled `Button` that opens a small dropdown menu — the generic "button
 * → action list" shape used anywhere in this app a toolbar button needs more
 * than one action (first use: TopBar.tsx's "+ Clip" menu, "Upload clip
 * file" / "Generate clip (AI)", see TTS_CARTESIA_PLAN.md). Lives in `ui/`
 * alongside `Button.tsx`/`LoadingState.tsx` since it's a generic reusable
 * primitive, not owned by any one feature.
 *
 * Deliberately a sibling of `clip-menu/ClipActionsMenu.tsx`, not a
 * generalization of it: that component's trigger is a fixed, internal
 * dots-icon `<button ref={buttonRef}>`, and threading a caller-owned ref
 * back out of it — what a differently-styled trigger like this one needs —
 * trips this repo's `eslint-plugin-react-hooks` "refs" rule (it flags a ref
 * crossing any function call made during render, regardless of what the
 * callee does with it), and this repo holds a clean `eslint` run as a hard
 * bar with zero existing suppressions anywhere (see CLAUDE.md's
 * Verification section). This component instead owns its trigger outright
 * (a plain `Button`, styled via the caller's own `label`), duplicating
 * `ClipActionsMenu`'s proven dropdown shape (portaled, fixed-positioned off
 * the trigger's own `getBoundingClientRect`, viewport-clamped, Escape/
 * outside-click dismiss, `role="menu"`/`menuitem`) rather than fighting that
 * rule for a shared component.
 */
export function MenuButton({
  label,
  actions,
  icon,
  minWidth = DEFAULT_DROPDOWN_MIN_WIDTH,
}: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dropHeight = dropdownRef.current?.offsetHeight ?? 100;

    let left = rect.right - minWidth;
    left = Math.max(4, Math.min(left, vw - minWidth - 4));

    let top = rect.bottom + 4;
    if (top + dropHeight > vh - 4) {
      top = Math.max(4, rect.top - dropHeight - 4);
    }
    setDropdownPos({ top, left });
  }, [minWidth]);

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
  }, [open]);

  return (
    <>
      <Button
        ref={buttonRef}
        variant="secondary"
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </Button>
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            role="menu"
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              minWidth,
              zIndex: 10000,
            }}
            className="overflow-hidden rounded-xl border border-[var(--border)] bg-white py-1 shadow-lg"
          >
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  action.onSelect();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--foreground)] hover:bg-[var(--accent-purple-50)]"
              >
                {action.icon}
                {action.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
