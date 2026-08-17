"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePlaylistData, usePlaylistControls } from "@waveform-playlist/browser";
import { formatTime } from "@waveform-playlist/ui-components";
import { Button } from "../ui/Button";
import { LoadingState } from "../ui/LoadingState";
import { useTranscriptIndex } from "../../hooks/useTranscriptIndex";
import {
  searchClipWordIndex,
  capSearchResults,
  CONTEXT_WORD_COUNT,
  MAX_SEARCH_RESULTS,
  type SearchResult,
} from "../../utils/transcriptSearch";
import type { SelectedClip } from "../clip-menu/ClipActionsToolbar";

interface SearchButtonProps {
  /** Selects the matched clip on the timeline — EditorShell.tsx's own
   *  setSelectedClip, threaded down the same way onDuplicateClip/
   *  onDeleteClip already are. */
  onSelectClip: (clip: SelectedClip) => void;
  /** Scrolls the timeline to center on a result's seek target —
   *  EditorShell.tsx's own handleScrollToTime. seekTo() below only moves the
   *  playhead itself; the library's own scroll-follow never runs from a
   *  plain seek while paused (see utils/timelineScroll.ts's doc comment), so
   *  without this a result far outside the current viewport would select and
   *  seek correctly but stay invisible until the user scrolled manually. */
  onScrollToTime: (seconds: number) => void;
}

const POPOVER_WIDTH = 380;
// Matches the popover's own `max-h-[28rem]` className below — used as the
// pre-mount fallback for updatePosition's vertical clamp, before
// popoverRef.current exists to measure a real height from.
const POPOVER_MAX_HEIGHT = 448;
// How much breathing room the popover keeps from the viewport's own edges on
// every side (previously only enforced left/right).
const VIEWPORT_EDGE_INSET_PX = 8;
// No decimals — a result's timestamp only needs to orient the user, not
// pinpoint the millisecond. Deliberately NOT usePlaylistControls().formatTime
// (which drives current-time/total-duration elsewhere at their own,
// unrelated precision) — the standalone formatTime here is scoped to this
// component only, no app-wide time-format change.
const RESULT_TIME_FORMAT = "hh:mm:ss" as const;
// Below this, a query is too short to be a meaningful search — searching on
// every keystroke from the first letter would mostly just match noise.
const MIN_QUERY_LENGTH = 3;

/**
 * Search icon + anchored popover — "Search in the podcast" title, an input,
 * and a scrollable result list. Self-contained (owns its own open/query/
 * results state) and portaled/fixed-positioned/viewport-clamped, the same
 * shape MenuButton.tsx already established (this repo's own precedent for
 * "why not share a component with ClipActionsMenu" applies equally here —
 * see that file's doc comment).
 *
 * Search runs instantly as the user types, once the query reaches
 * MIN_QUERY_LENGTH — no Enter press needed.
 *
 * Query and results are deliberately NOT cleared when the popover closes —
 * closing only toggles visibility (`open`), this component instance itself
 * never unmounts (SearchButton lives in TopBar.tsx, which survives every
 * engine rebuild) — satisfying "search and its results persist until the
 * user clears them" for free, with no extra store needed.
 */
export function SearchButton({ onSelectClip, onScrollToTime }: SearchButtonProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { tracks } = usePlaylistData();
  const { seekTo } = usePlaylistControls();
  const { index, isTranscribing } = useTranscriptIndex(tracks);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length >= MIN_QUERY_LENGTH;
  // The one real wait this popover has: a clip's transcript still catching
  // up while the user types. Deliberate: per
  // TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 5, search must never
  // surface "transcription in progress" as its own concept to the user —
  // it just shows the same "Searching…" state until it settles.
  const isSearching = hasQuery && isTranscribing;

  // Capped to MAX_SEARCH_RESULTS — a common word can match hundreds of times
  // across a real podcast; searchClipWordIndex itself still returns every
  // match (its own contract, independently tested), capping is applied here
  // by the caller. See utils/transcriptSearch.ts's capSearchResults doc
  // comment.
  const searchOutcome = useMemo(
    () => (hasQuery && !isTranscribing ? capSearchResults(searchClipWordIndex(index, trimmedQuery)) : null),
    [index, trimmedQuery, hasQuery, isTranscribing]
  );
  const results: SearchResult[] = searchOutcome?.results ?? [];

  // Clamped on all four sides against the viewport, not just left/right —
  // previously only horizontal clamping existed, so a popover opened near
  // the bottom of the window (or a short window overall) could run its
  // bottom edge straight off-screen. Mirrors MenuButton.tsx's own
  // "flip above the trigger if there isn't room below" rule rather than
  // just clipping in place, so the whole popover always stays reachable.
  const updatePosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const popoverHeight = popoverRef.current?.offsetHeight ?? POPOVER_MAX_HEIGHT;

    const left = Math.max(
      VIEWPORT_EDGE_INSET_PX,
      Math.min(rect.right - POPOVER_WIDTH, vw - POPOVER_WIDTH - VIEWPORT_EDGE_INSET_PX)
    );

    let top = rect.bottom + 8;
    if (top + popoverHeight > vh - VIEWPORT_EDGE_INSET_PX) {
      top = Math.max(VIEWPORT_EDGE_INSET_PX, rect.top - popoverHeight - 8);
    }
    setPopoverPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    // The popover's real height isn't known until it's actually mounted and
    // painted — this re-measures once that's happened, same two-pass
    // approach MenuButton.tsx's own updatePosition effect already uses.
    const raf = requestAnimationFrame(updatePosition);
    inputRef.current?.focus();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open, updatePosition]);

  // The popover's own content height changes as a search settles (a short
  // placeholder vs. a full, possibly-truncated result list) — re-clamp
  // whenever that happens so a vertical flip (above/below the trigger)
  // reflects the content actually on screen, not stale content from the
  // moment the popover first opened.
  useEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition, results.length, isSearching, searchOutcome?.truncated]);

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
    onScrollToTime(result.seekTimelineStart);
  };

  return (
    <>
      {/* variant="secondary" + a leading icon matches the "+ Clip"/"Export"
       *  buttons it now sits beside in TopBar.tsx, rather than the small
       *  circular icon-only style this used before — one visual family
       *  across every top-bar action, not a lone round outlier. aria-label
       *  wins over the visible "Search" text for the accessible name (per
       *  the standard accname computation), so this keeps the fuller
       *  "Search in the podcast" name existing e2e coverage already queries
       *  by. */}
      <Button
        ref={buttonRef}
        variant="secondary"
        icon={<SearchIcon />}
        title="Search in the podcast"
        aria-label="Search in the podcast"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Search
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
                  placeholder="Search words or phrases…"
                  className="w-full rounded-lg border border-[var(--border)] py-2 pl-8 pr-3 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-purple-500)]"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {query.length < MIN_QUERY_LENGTH && (
                <p className="px-2 py-6 text-center text-sm text-[var(--text-muted)]">
                  Type a word or phrase to search.
                </p>
              )}
              {hasQuery && isSearching && (
                <div className="py-6">
                  <LoadingState message="Searching…" bare />
                </div>
              )}
              {hasQuery && !isSearching && results.length === 0 && (
                <p className="px-2 py-6 text-center text-sm text-[var(--text-muted)]">
                  No matches for &ldquo;{trimmedQuery}&rdquo;.
                </p>
              )}
              {hasQuery && !isSearching && results.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {results.map((result, i) => (
                    <li key={`${result.clipId}-${result.timelineStart}-${i}`}>
                      <SearchResultRow result={result} onSelect={() => handleSelectResult(result)} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {/* A common word can match hundreds of times in a real podcast —
             *  results are capped at MAX_SEARCH_RESULTS (see
             *  utils/transcriptSearch.ts's capSearchResults); this discloses
             *  the cap instead of silently truncating, and says how many
             *  more exist so the user knows to narrow the query rather than
             *  wondering if search is broken. */}
            {hasQuery && !isSearching && searchOutcome?.truncated && (
              <div className="shrink-0 border-t border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-center text-xs text-[var(--text-muted)]">
                Showing top {MAX_SEARCH_RESULTS} of {searchOutcome.totalMatches} matches — refine your search.
              </div>
            )}
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
