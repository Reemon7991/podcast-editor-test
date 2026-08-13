/**
 * Icon set shared by every surface that exposes the same clip actions —
 * `ClipActionsToolbar.tsx` (top bar, gated on a selected clip) and
 * `ClipActionsOverlay.tsx` (per-clip "..." menu, via `ClipActionsMenu.tsx`).
 * Kept in one place so "Split" (for example) never quietly grows two
 * different glyphs across the two surfaces it appears on.
 */

export function SplitIcon() {
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
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

export function DuplicateIcon() {
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
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function DeleteIcon() {
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
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/** A waveform with its quiet middle flattened to near-nothing — the most
 *  literal available glyph for "find the quiet part and cut it out", and
 *  distinct from Split's scissors (that cuts a clip in two; this removes a
 *  span from within one). */
export function RemoveSilenceIcon() {
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
      <path d="M2 12h2" />
      <path d="M8 6v12" />
      <path d="M13 9v6" />
      <path d="M16 11v2" />
      <path d="M20 6v12" />
    </svg>
  );
}

/** A speech bubble with its spoken content struck through — reads as "cut
 *  the words that were said", distinct from RemoveSilenceIcon's flattened
 *  waveform (that targets the gaps *between* words; this targets specific
 *  words themselves). Three dots stand in for "um…"-style hesitation rather
 *  than legible text (matching this icon set's existing economy — no literal
 *  letterforms anywhere else in it either); rendered filled, not stroked,
 *  so they stay a crisp, single-color mark at 16px instead of a stroked
 *  wavy line's fuzzier, three-stroke-elements-competing look at that size
 *  (visually checked at both 16px and 96px before settling on this shape —
 *  an earlier wavy-line version read as cluttered at actual menu-item size). */
export function RemoveFillerWordsIcon() {
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
      <path d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
      <circle cx="8.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <line x1="4" y1="17" x2="20" y2="4" />
    </svg>
  );
}
