interface LoadingStateProps {
  message: string;
  /** Skip the card border/background — for use already nested inside
   *  another bordered container (e.g. EditorShell.tsx's waveform box), where
   *  a second border/background would just double up. */
  bare?: boolean;
}

/**
 * Shared visual treatment for this app's three sequential loading stages
 * (PodcastEditorLoader's dynamic-import loading, PodcastEditor's IndexedDB
 * hydration, EditorShell's per-rebuild "Building waveform…") — one spinner
 * markup instead of three near-identical copies.
 */
export function LoadingState({ message, bare = false }: LoadingStateProps) {
  return (
    <div
      className={
        bare
          ? "flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]"
          : "flex items-center justify-center gap-2 rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--text-muted)]"
      }
    >
      <Spinner />
      {message}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-[var(--accent-purple-500)]"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
