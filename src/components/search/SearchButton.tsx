"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePlaylistData, usePlaylistControls } from "@waveform-playlist/browser";
import { formatTime } from "@waveform-playlist/ui-components";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/LoadingState";
import { useTranscriptIndex } from "../../hooks/useTranscriptIndex";
import { searchClipWordIndex, CONTEXT_WORD_COUNT, type SearchResult } from "../../utils/transcriptSearch";
import type { SelectedClip } from "../clip-menu/ClipActionsToolbar";

interface SearchButtonProps {
  /** Selects the matched clip on the timeline — EditorShell.tsx's own
   *  setSelectedClip, threaded down the same way onDuplicateClip/
   *  onDeleteClip already are. */
  onSelectClip: (clip: SelectedClip) => void;
}

const POPOVER_WIDTH = 380;
// No decimals — a result's timestamp only needs to orient the user, not
// pinpoint the millisecond. Deliberately NOT usePlaylistControls().formatTime
// (which drives current-time/total-duration elsewhere at their own,
// unrelated precision) — the standalone formatTime here is scoped to this
// component only, no app-wide time-format change.
const RESULT_TIME_FORMAT = "hh:mm:ss" as const;

/**
 * Search icon + anchored popover — "Search in the podcast" title, an input,
 * and a scrollable result list. Self-contained (owns its own open/query/
 * results state) and portaled/fixed-positioned/viewport-clamped, the same
 * shape MenuButton.tsx already established (this repo's own precedent for
 * "why not share a component with ClipActionsMenu" applies equally here —
 * see that file's doc comment).
 *
 * Query and results are deliberately NOT cleared when the popover closes —
 * closing only toggles visibility (`open`), this component instance itself
 * never unmounts (SearchButton lives in TopBar.tsx, which survives every
 * engine rebuild) — satisfying "search and its results persist until the
 * user clears them" for free, with no extra store needed.
 *
 * Search runs on Enter, not on every keystroke — `query` is the live input
 * value, `submittedQuery` is the last one actually searched. Editing the
 * input after submitting doesn't blank the current results; only pressing
 * Enter again re-runs the search against the new text.
 */
export function SearchButton({ onSelectClip }: SearchButtonProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { tracks } = usePlaylistData();
  const { seekTo } = usePlaylistControls();
  const { index, isTranscribing } = useTranscriptIndex(tracks);

  const hasSubmittedQuery = submittedQuery.trim().length > 0;
  // The one real wait this popover has: a clip's transcript still catching
  // up when Enter is pressed. Deliberate: per
  // TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 5, search must never
  // surface "transcription in progress" as its own concept to the user —
  // it just shows the same "Searching…" state until it settles.
  const isSearching = hasSubmittedQuery && isTranscribing;

  const results = useMemo<SearchResult[]>(
    () => (hasSubmittedQuery && !isTranscribing ? searchClipWordIndex(index, submittedQuery) : []),
    [index, submittedQuery, hasSubmittedQuery, isTranscribing]
  );

  const handleInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setSubmittedQuery(query);
    }
  };

  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const left = Math.max(8, Math.min(rect.right - POPOVER_WIDTH, vw - POPOVER_WIDTH - 8));
    setPopoverPos({ top: rect.bottom + 8, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    inputRef.current?.focus();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  // Closes on outside click / Escape — does not clear query/results, same
  // "close ≠ clear" distinction this component's own doc comment above
  // establishes.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
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

  const handleSelectResult = (result: SearchResult) => {
    onSelectClip({ trackId: result.trackId, clipId: result.clipId });
    seekTo(result.seekTimelineStart);
  };

  return (
    <>
      <Button
        ref={buttonRef}
        variant="icon"
        title="Search in the podcast"
        aria-label="Search in the podcast"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <SearchIcon />
      </Button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Search in the podcast"
            style={{
              position: "fixed",
              top: popoverPos.top,
              left: popoverPos.left,
              width: POPOVER_WIDTH,
              zIndex: 10000,
            }}
            className="flex max-h-[28rem] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-lg"
          >
            <div className="shrink-0 border-b border-[var(--border)] p-3">
              <h2 className="mb-2 text-sm font-semibold text-[var(--foreground)]">Search in the podcast</h2>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                  <SearchIcon />
                </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleInputKeyDown}
                  placeholder="Search words or phrases…"
                  className="w-full rounded-lg border border-[var(--border)] py-2 pl-8 pr-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-purple-500)]"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {!hasSubmittedQuery && (
                <p className="px-2 py-6 text-center text-sm text-[var(--text-muted)]">
                  Type a word or phrase, then press Enter to search.
                </p>
              )}
              {hasSubmittedQuery && isSearching && (
                <div className="py-6">
                  <LoadingState message="Searching…" bare />
                </div>
              )}
              {hasSubmittedQuery && !isSearching && results.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-[var(--text-muted)]">
                  No matches for &ldquo;{submittedQuery.trim()}&rdquo;.
                </p>
              )}
              {hasSubmittedQuery && !isSearching && results.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {results.map((result, i) => (
                    <li key={`${result.clipId}-${result.timelineStart}-${i}`}>
                      <SearchResultRow result={result} onSelect={() => handleSelectResult(result)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

interface SearchResultRowProps {
  result: SearchResult;
  onSelect: () => void;
}

/** One result card — clip name + timestamp, then the match in context. The
 *  matched text is a real `<mark>` (semantically correct for "highlighted
 *  text"), styled with this app's existing clip-label purple wash
 *  (`--accent-purple-100`/`--accent-purple-700`, the same pair
 *  ClipActionsOverlay.tsx's own clip name labels already use) rather than a
 *  new color — reads as "highlighter over a transcript," fitting for what
 *  this actually is. Ellipses only appear when context was truncated at
 *  CONTEXT_WORD_COUNT (there's genuinely more before/after) — not shown for
 *  a match that's simply near a clip's own edge, which would misleadingly
 *  imply cut-off content that doesn't exist. */
function SearchResultRow({ result, onSelect }: SearchResultRowProps) {
  const showEllipsisBefore = result.contextBefore.length === CONTEXT_WORD_COUNT;
  const showEllipsisAfter = result.contextAfter.length === CONTEXT_WORD_COUNT;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full rounded-xl border border-transparent p-2.5 text-left transition-colors hover:border-[var(--accent-purple-200)] hover:bg-[var(--accent-purple-50)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-purple-500)]"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-[var(--text-muted)]">{result.clipName}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-muted)]">
          {formatTime(result.timelineStart, RESULT_TIME_FORMAT)}
        </span>
      </div>
      <p className="text-sm leading-snug text-[var(--foreground)]">
        {(showEllipsisBefore || result.contextBefore.length > 0) && (
          <span className="text-[var(--text-muted)]">
            {showEllipsisBefore && "…"}
            {result.contextBefore.join(" ")}{" "}
          </span>
        )}
        <mark className="rounded bg-[var(--accent-purple-100)] px-0.5 font-semibold text-[var(--accent-purple-700)]">
          {result.matchText}
        </mark>
        {(showEllipsisAfter || result.contextAfter.length > 0) && (
          <span className="text-[var(--text-muted)]">
            {" "}
            {result.contextAfter.join(" ")}
            {showEllipsisAfter && "…"}
          </span>
        )}
      </p>
    </button>
  );
}

function SearchIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
