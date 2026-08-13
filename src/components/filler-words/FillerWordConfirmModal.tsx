"use client";

import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/Button";
import type { FillerWordSummaryEntry } from "../../utils/fillerWordDetection";

interface FillerWordConfirmModalProps {
  clipName: string;
  summary: FillerWordSummaryEntry[];
  totalCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * "Remove filler words?" confirmation — opens after useFillerWordRemoval.ts's
 * detectForClip() finds at least one match. Unlike silence removal (which
 * applies blind, no review step — RMS-based detection has no false-positive
 * risk worth pausing for), filler-word matching is dictionary-based against
 * real words, so a lightweight confirm-with-counts step is worth the one
 * extra click; a full per-occurrence checklist would be more than this
 * dictionary's deliberately narrow, low-ambiguity word list (see
 * utils/fillerWords.ts) actually needs. See
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 6.
 *
 * Portaled-centered-modal shape modeled on GenerateSpeechModal.tsx (mount =
 * visible, no internal open/closed state, backdrop click + Escape both
 * cancel) — same family, not a new pattern.
 */
export function FillerWordConfirmModal({
  clipName,
  summary,
  totalCount,
  onConfirm,
  onCancel,
}: FillerWordConfirmModalProps) {
  const titleId = useId();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
      onPointerDown={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-[var(--border)] bg-white p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-1 text-sm font-semibold text-[var(--foreground)]">
          Remove filler words?
        </h2>
        <p className="mb-3 truncate text-xs text-[var(--text-muted)]" title={clipName}>
          Found in &ldquo;{clipName}&rdquo;
        </p>

        <ul className="mb-4 flex flex-col gap-1.5">
          {summary.map((entry) => (
            <li
              key={entry.label}
              className="flex items-center justify-between gap-3 rounded-lg bg-[var(--surface)] px-3 py-1.5"
            >
              <span
                dir="auto"
                className="rounded bg-[var(--accent-purple-100)] px-1.5 py-0.5 text-sm font-semibold text-[var(--accent-purple-700)]"
              >
                {entry.label}
              </span>
              <span className="font-mono text-xs tabular-nums text-[var(--text-muted)]">
                × {entry.count}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>
            Remove {totalCount === 1 ? "1 word" : `${totalCount} words`}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
