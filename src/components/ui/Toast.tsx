"use client";

import { useEffect } from "react";

export type ToastVariant = "success" | "warning" | "error";

export interface ToastMessage {
  variant: ToastVariant;
  text: string;
}

const AUTO_DISMISS_MS = 5000;

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  success: "border-emerald-300 bg-emerald-50 text-emerald-800",
  warning: "border-amber-300 bg-amber-50 text-amber-800",
  error: "border-red-300 bg-red-50 text-red-800",
};

/**
 * Transient outcome toast — bottom-center, auto-dismissing after
 * AUTO_DISMISS_MS. For "an action just finished, here's what happened"
 * (succeeded / no-op / failed), as opposed to ui/WarningBanner.tsx's
 * persistent, manually-dismissed banners for ongoing degraded state (a
 * failed asset save, dropped clips on hydration) — that distinction is why
 * this doesn't just reuse WarningBanner with a timer bolted on. Same three-
 * variant shape and visual weight across success/warning/error, only the
 * color changes, so the three read as one family, not three different UI
 * languages.
 */
export function Toast({ message, onDismiss }: { message: ToastMessage; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div className="fixed inset-x-0 bottom-28 z-[300] flex justify-center px-4">
      <div
        role="status"
        className={`motion-safe:animate-[toast-in_0.25s_ease-out] flex items-center gap-2.5 rounded-full border px-4 py-2.5 text-sm shadow-lg ${VARIANT_CLASSES[message.variant]}`}
      >
        <VariantIcon variant={message.variant} />
        <span>{message.text}</span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="opacity-60 transition-opacity hover:opacity-100"
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

function VariantIcon({ variant }: { variant: ToastVariant }) {
  if (variant === "success") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
        <path
          d="M5 13l4 4L19 7"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (variant === "warning") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
        <path
          d="M12 4l9 16H3l9-16z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M12 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
