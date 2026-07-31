"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "icon";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon for `primary`/`secondary`/`ghost` (rendered left of
   *  `children`). Ignored for `variant="icon"` — there, `children` itself
   *  is the icon and must come with a real `title`/`aria-label` since no
   *  label text is rendered. */
  icon?: ReactNode;
}

const SIZE_CLASSES: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary: { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm" },
  secondary: { sm: "h-8 px-3 text-xs", md: "h-9 px-4 text-sm" },
  ghost: { sm: "h-8 px-2.5 text-xs", md: "h-9 px-3 text-sm" },
  icon: { sm: "h-7 w-7", md: "h-8 w-8" },
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--accent-purple-500)] text-white hover:bg-[var(--accent-purple-600)]",
  secondary:
    "border border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-[var(--surface)]",
  ghost: "bg-transparent text-[var(--foreground)] hover:bg-[var(--surface)]",
  icon: "bg-transparent text-zinc-600 hover:bg-[var(--surface)] hover:text-[var(--accent-purple-600)]",
};

/**
 * Shared button primitive — replaces the ~6 near-duplicate hand-rolled
 * Tailwind className strings previously scattered across
 * TransportControls/ExportButton/EditorShell's "New Track"/
 * ClipSwapConfirmPopover/ClipActionsMenu. `variant="icon"` is a circular
 * icon-only button (Undo/Redo, Split/Duplicate/Delete, Zoom, Play/Pause);
 * the other three variants are pill-shaped and take an optional leading
 * `icon` alongside a text label (Upload/Export).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, children, className = "", disabled, ...rest },
  ref
) {
  const shape = variant === "icon" ? "rounded-full" : "rounded-full";
  const classes = [
    "inline-flex items-center justify-center gap-1.5 font-medium transition-colors",
    "disabled:cursor-not-allowed disabled:opacity-40",
    shape,
    SIZE_CLASSES[variant][size],
    VARIANT_CLASSES[variant],
    className,
  ].join(" ");

  return (
    <button ref={ref} type="button" disabled={disabled} className={classes} {...rest}>
      {variant === "icon" ? (
        children
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
});
