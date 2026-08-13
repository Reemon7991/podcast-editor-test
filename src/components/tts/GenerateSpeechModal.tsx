"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/Button";
import { DEFAULT_CARTESIA_VOICE_ID, MAX_TTS_TEXT_LENGTH } from "../../utils/cartesiaVoices";
import { useGenerateSpeech } from "../../hooks/useGenerateSpeech";
import { useCartesiaVoices } from "../../hooks/useCartesiaVoices";
import { useVoicePreviewPlayer } from "../../hooks/useVoicePreviewPlayer";
import { VoicePicker } from "./VoicePicker";

interface GenerateSpeechModalProps {
  /** `activeTrackIdRef.current` read by the caller at open time — same
   *  sticky ref TopBar's upload path already reads. Null only if no track
   *  exists yet (shouldn't normally happen — the store always seeds one
   *  empty track — but guarded the same way handleUpload guards it). */
  trackId: string | null;
  /** The live playhead position (`usePlaybackAnimation().currentTime`),
   *  threaded down from TopBar.tsx the same way handleUpload already reads
   *  it — generated audio lands at the playhead on the active track,
   *  exactly like an uploaded clip. */
  insertionTimeSeconds: number;
  onClose: () => void;
}

/**
 * Centered modal for "Generate clip (AI)" — see TTS_CARTESIA_PLAN.md.
 * Mounted only while open (TopBar.tsx renders it conditionally), so it has
 * no open/closed state of its own, same "controlled, mount = visible"
 * pattern ClipSwapConfirmPopover.tsx already uses, adapted from an anchored
 * popover to a centered modal + backdrop.
 */
export function GenerateSpeechModal({ trackId, insertionTimeSeconds, onClose }: GenerateSpeechModalProps) {
  const [text, setText] = useState("");
  const [voiceId, setVoiceId] = useState(DEFAULT_CARTESIA_VOICE_ID);
  const { generateSpeech, isGenerating, error } = useGenerateSpeech();
  const { voices } = useCartesiaVoices();
  const { playingVoiceId, loadingVoiceId, error: previewError, toggle: togglePreview } = useVoicePreviewPlayer();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Escape dismisses, same as ClipSwapConfirmPopover/ClipActionsMenu —
  // except while a request is in flight, so a generate call that's about to
  // succeed or fail can't be abandoned mid-air with no result shown.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isGenerating) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isGenerating, onClose]);

  const overLimit = text.length > MAX_TTS_TEXT_LENGTH;
  const canGenerate = trackId !== null && text.trim().length > 0 && !overLimit && !isGenerating;

  const handleGenerate = () => {
    if (!canGenerate || trackId === null) return;
    generateSpeech(trackId, insertionTimeSeconds, text, voiceId).then((inserted) => {
      if (inserted) onClose();
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
      onPointerDown={() => {
        if (!isGenerating) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onPointerDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-white p-5 shadow-xl"
      >
        <h2 id={titleId} className="mb-3 text-sm font-semibold text-[var(--foreground)]">
          Generate clip (AI)
        </h2>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-[var(--text-muted)]">Text</span>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={isGenerating}
            rows={5}
            placeholder="Type the words you want spoken…"
            className="w-full resize-none rounded-lg border border-[var(--border)] p-2 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-purple-500)] disabled:opacity-60"
          />
          {/* No `maxLength` on the textarea on purpose — that silently clips
              a long paste with zero feedback. Show the count instead and let
              Generate itself block over-limit text. */}
          <div className="mt-1 flex items-start justify-between gap-2">
            <span className="flex-1 text-xs text-red-600">
              {overLimit
                ? `${(text.length - MAX_TTS_TEXT_LENGTH).toLocaleString()} characters over the limit.`
                : error}
            </span>
            <span className={`shrink-0 text-xs ${overLimit ? "text-red-600" : "text-[var(--text-muted)]"}`}>
              {text.length.toLocaleString()} / {MAX_TTS_TEXT_LENGTH.toLocaleString()}
            </span>
          </div>
        </label>

        <div className="mb-4">
          <span className="mb-1 block text-sm text-[var(--text-muted)]">Voice</span>
          <VoicePicker
            voices={voices}
            voiceId={voiceId}
            onSelectVoice={setVoiceId}
            disabled={isGenerating}
            playingVoiceId={playingVoiceId}
            loadingVoiceId={loadingVoiceId}
            onTogglePreview={togglePreview}
          />
          {previewError && <p className="mt-1 text-xs text-red-600">{previewError}</p>}
        </div>

        {trackId === null && (
          <p className="mb-3 text-xs text-red-600">Add a track first.</p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isGenerating}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleGenerate} disabled={!canGenerate}>
            {isGenerating ? "Generating…" : "Generate"}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
