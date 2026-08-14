"use client";

/** Dismissible inline banner for non-fatal, recoverable-this-session issues
 *  (dropped clips on hydration, a failed asset save, a no-op edit) — same
 *  "surface it in the UI, don't just console.warn" precedent as
 *  TimelineStage.tsx's red providerError banner, amber rather than red
 *  since these aren't fatal. */
export function WarningBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      <span>{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 text-amber-700 hover:text-amber-900"
      >
        ✕
      </button>
    </div>
  );
}
