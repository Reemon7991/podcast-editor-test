"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { CartesiaVoiceOption } from "../../hooks/useCartesiaVoices";

interface VoicePickerProps {
  voices: CartesiaVoiceOption[];
  voiceId: string;
  onSelectVoice: (voiceId: string) => void;
  disabled?: boolean;
  playingVoiceId: string | null;
  loadingVoiceId: string | null;
  onTogglePreview: (voiceId: string) => void;
}

/**
 * Custom voice picker — replaces a plain `<select>` so each row can carry
 * its own inline preview play button. A native `<option>` can only ever be
 * plain text (the browser renders a `<select>`'s open list itself, with no
 * styling/content control from us — confirmed by trying, not assumed), so
 * that's not achievable with a real `<select>` at all. Portaled/positioned/
 * dismissed the same way `ui/MenuButton.tsx`'s dropdown already is;
 * `role="listbox"`/`"option"` here instead of `"menu"`/`"menuitem"` since
 * this behaves like `<select>` (one persistent selected value that stays
 * visible on the closed trigger), not a one-shot action list.
 */
export function VoicePicker({
  voices,
  voiceId,
  onSelectVoice,
  disabled,
  playingVoiceId,
  loadingVoiceId,
  onTogglePreview,
}: VoicePickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selectedVoice = voices.find((v) => v.id === voiceId);
  const selectedIndex = Math.max(0, voices.findIndex((v) => v.id === voiceId));

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const vh = window.innerHeight;
    const dropHeight = dropdownRef.current?.offsetHeight ?? 200;

    let top = rect.bottom + 4;
    if (top + dropHeight > vh - 4) {
      top = Math.max(4, rect.top - dropHeight - 4);
    }
    setDropdownPos({ top, left: rect.left, width: rect.width });
  }, []);

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

  // Opens the list AND seeds activeIndex to the current selection in one go
  // — both from the same event handler (click/keydown), never from an
  // effect (this repo's eslint-plugin-react-hooks flags synchronous setState
  // inside an effect body; seeding activeIndex here instead of reacting to
  // `open` becoming true sidesteps that rule cleanly, not just silences it).
  const openList = useCallback(() => {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const closeAndFocusTrigger = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const handleTriggerKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openList();
    }
  };

  // Basic combobox keyboard support (Up/Down/Enter/Escape) — a native
  // <select> gets this for free from the browser; replacing it with a
  // custom list means reimplementing at least this much or regressing
  // keyboard users.
  const handleListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAndFocusTrigger();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(voices.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const voice = voices[activeIndex];
      if (voice) {
        onSelectVoice(voice.id);
        closeAndFocusTrigger();
      }
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label="Voice"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={handleTriggerKeyDown}
        className="flex w-full items-center justify-between rounded-lg border border-[var(--border)] bg-white p-2 text-left text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-purple-500)] disabled:opacity-60"
      >
        <span className="truncate">{selectedVoice?.name ?? "Select a voice…"}</span>
        <ChevronDownIcon />
      </button>
      {open &&
        createPortal(
          <div
            id={listboxId}
            ref={dropdownRef}
            role="listbox"
            aria-label="Voice"
            tabIndex={-1}
            onKeyDown={handleListKeyDown}
            style={{
              position: "fixed",
              top: dropdownPos.top,
              left: dropdownPos.left,
              width: dropdownPos.width,
              zIndex: 10000,
            }}
            className="max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-white py-1 shadow-lg"
          >
            {voices.map((voice, index) => {
              const isSelected = voice.id === voiceId;
              const isActive = index === activeIndex;
              const isVoicePlaying = playingVoiceId === voice.id;
              const isVoiceLoading = loadingVoiceId === voice.id;
              return (
                <div
                  key={voice.id}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    onSelectVoice(voice.id);
                    closeAndFocusTrigger();
                  }}
                  className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm ${
                    isActive ? "bg-[var(--accent-purple-50)]" : ""
                  } ${isSelected ? "font-semibold text-[var(--accent-purple-700)]" : "text-[var(--foreground)]"}`}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePreview(voice.id);
                    }}
                    disabled={!voice.hasPreview || isVoiceLoading}
                    title={voice.hasPreview ? "Preview this voice" : "No preview available for this voice"}
                    aria-label={isVoicePlaying ? `Stop preview of ${voice.name}` : `Preview ${voice.name}`}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--accent-purple-700)] hover:bg-[var(--accent-purple-700)]/10 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    {isVoiceLoading ? <PreviewLoadingIcon /> : isVoicePlaying ? <PreviewPauseIcon /> : <PreviewPlayIcon />}
                  </button>
                  <span className="flex-1 truncate">{voice.name}</span>
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

function ChevronDownIcon() {
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
      className="shrink-0 opacity-60"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function PreviewPlayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

function PreviewPauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="2.5" width="3" height="11" rx="1" />
      <rect x="9" y="2.5" width="3" height="11" rx="1" />
    </svg>
  );
}

function PreviewLoadingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="animate-spin" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
