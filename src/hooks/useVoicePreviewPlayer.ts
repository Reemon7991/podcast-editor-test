"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Plays one voice's preview at a time via `/api/tts/voice-preview` — a
 *  second toggle() while one is already loading/playing stops it first, so
 *  only ever one `Audio` element is live. */
export function useVoicePreviewPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [loadingVoiceId, setLoadingVoiceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingVoiceId(null);
    setLoadingVoiceId(null);
  }, []);

  const toggle = useCallback(
    async (voiceId: string) => {
      setError(null);
      if (playingVoiceId === voiceId || loadingVoiceId === voiceId) {
        stop();
        return;
      }
      stop();
      setLoadingVoiceId(voiceId);

      const audio = new Audio(`/api/tts/voice-preview?voiceId=${encodeURIComponent(voiceId)}`);
      // Switching to a different voice calls stop() -> audio.pause(), which
      // rejects THIS audio's still-pending play() promise (browsers reject a
      // pending play() when pause() interrupts it) — every callback below
      // checks isCurrent() first so that rejection/event doesn't clobber
      // state that already moved on to the voice the user actually switched
      // to.
      const isCurrent = () => audioRef.current === audio;

      audio.addEventListener("ended", () => {
        if (isCurrent()) setPlayingVoiceId(null);
      });
      audio.addEventListener("error", () => {
        if (!isCurrent()) return;
        setLoadingVoiceId(null);
        setPlayingVoiceId(null);
        setError("Couldn't play preview for this voice.");
      });
      audioRef.current = audio;

      try {
        await audio.play();
        if (isCurrent()) {
          setLoadingVoiceId(null);
          setPlayingVoiceId(voiceId);
        }
      } catch (err) {
        if (!isCurrent()) return; // interrupted by switching voices, not a real failure
        console.error("[podcast-editor] Voice preview playback failed", err);
        setLoadingVoiceId(null);
        setError("Couldn't play preview for this voice.");
      }
    },
    [playingVoiceId, loadingVoiceId, stop]
  );

  return { playingVoiceId, loadingVoiceId, error, toggle };
}
