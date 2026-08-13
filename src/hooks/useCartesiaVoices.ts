"use client";

import { useEffect, useState } from "react";
import { FALLBACK_CARTESIA_VOICES } from "../utils/cartesiaVoices";

export interface CartesiaVoiceOption {
  id: string;
  name: string;
  description: string | null;
  hasPreview: boolean;
}

const FALLBACK_OPTIONS: CartesiaVoiceOption[] = FALLBACK_CARTESIA_VOICES.map((v) => ({
  id: v.id,
  name: v.name,
  description: null,
  hasPreview: false,
}));

/** Live voice list for the "Generate clip (AI)" picker — fetched from
 *  `/api/tts/voices` (server-cached Cartesia call). Renders the static
 *  fallback list immediately (no empty/loading dropdown on modal open),
 *  swapped for live data once the fetch resolves. */
export function useCartesiaVoices(): { voices: CartesiaVoiceOption[]; isLoading: boolean } {
  const [voices, setVoices] = useState<CartesiaVoiceOption[]>(FALLBACK_OPTIONS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tts/voices")
      .then((res) => (res.ok ? (res.json() as Promise<{ voices?: CartesiaVoiceOption[] }>) : null))
      .then((body) => {
        if (cancelled || !body?.voices?.length) return;
        setVoices(body.voices);
      })
      .catch((err) => {
        console.error("[podcast-editor] Failed to load live Cartesia voice list, using fallback", err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { voices, isLoading };
}
