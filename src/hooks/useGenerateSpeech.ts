"use client";

import { useCallback, useRef, useState } from "react";
import * as Tone from "tone";
import { hashFileBytes, registerAsset } from "../utils/assetRegistry";
import { saveAsset, saveCompressedAsset } from "../utils/persistence";
import { resolveNonOverlappingStart } from "../utils/clipGeometry";
import { buildClipMeta } from "../utils/clipInsertion";
import { compressAsset } from "../utils/audioCompression";
import { runTranscriptionPipeline } from "../utils/transcription";
import { useProjectStore } from "../store/projectStore";

const CLIP_NAME_MAX_LENGTH = 40;

/** First ~40 chars of the input text (collapsed whitespace) + ellipsis if
 *  truncated — gives a generated clip a recognizable name instead of a
 *  generic "Generated speech" every time. */
function clipNameFromText(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return "Generated speech";
  return collapsed.length > CLIP_NAME_MAX_LENGTH
    ? `${collapsed.slice(0, CLIP_NAME_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * Generates a TTS clip via `POST /api/tts` and inserts it exactly like an
 * uploaded file — see TTS_CARTESIA_PLAN.md. Mirrors
 * `useTimelineTracks.ts`'s `addFilesToTrack` shape (decode → hash → register
 * in-memory → persist → commit), trimmed to the single-clip case: no
 * batch/cursor logic needed, since GenerateSpeechModal only ever has one
 * request in flight at a time.
 *
 * `isGenerating`/`error` are local hook state, not store fields — same
 * precedent `useProjectExport.ts` already sets for `isExporting`/`error`
 * (transient request-lifecycle state has no reason to be global). The
 * generated clip itself reaches the store only via the ordinary `commit()`
 * call below, so undo/redo and persistence fall out for free with zero
 * store changes.
 */
export function useGenerateSpeech() {
  const commit = useProjectStore((s) => s.commit);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards against a double-submit that `isGenerating` state alone can't
  // close: a second call landing before React has re-rendered/disabled the
  // Generate button (two rapid clicks, or a caller invoking this outside a
  // button entirely) would otherwise both pass a `!isGenerating` check and
  // fire two requests. Same reasoning this app's own `playPendingRef`
  // already documents (CLAUDE.md's play()/rebuild race) — a ref flips
  // synchronously, ahead of any render, where state can't.
  const isGeneratingRef = useRef(false);

  const generateSpeech = useCallback(
    async (
      trackId: string,
      insertionTimeSeconds: number,
      text: string,
      voiceId: string
    ): Promise<boolean> => {
      if (isGeneratingRef.current) return false;
      isGeneratingRef.current = true;
      setIsGenerating(true);
      setError(null);
      try {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId }),
        });

        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? "Speech generation failed. Please try again.");
          return false;
        }

        const arrayBuffer = await response.arrayBuffer();
        // Hash and wrap in a Blob *before* decoding, not after — mirrors
        // assetRegistry.ts's documented reason (decodeAudioData may detach
        // the ArrayBuffer it's given). assetId is content-addressed, so
        // regenerating identical bytes twice dedupes for free, same property
        // uploads already get.
        const blob = new Blob([arrayBuffer], { type: "audio/wav" });
        const assetId = await hashFileBytes(arrayBuffer);
        const audioContext = Tone.getContext().rawContext as AudioContext;
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        registerAsset(audioBuffer, assetId);
        // Persist concurrently-ish with the commit below; a save failure is
        // logged and swallowed, not thrown — same non-fatal treatment
        // addFilesToTrack gives a persist failure (the clip still works this
        // session, it just won't survive a reload).
        saveAsset(assetId, blob).catch((err) => {
          console.error("[podcast-editor] Failed to persist generated clip to IndexedDB", err);
        });

        // Compress + persist compressed chunks, then kick off background
        // transcription — same pipeline and same "generated audio needs
        // transcription too" requirement as an uploaded file gets in
        // useTimelineTracks.ts's addFilesToTrack. Awaited (blocks
        // isGenerating until it finishes, per the UX requirement); the
        // transcription call itself is not awaited. A failure here is
        // logged and swallowed — the generated clip still works normally,
        // it just won't be searchable or offer filler-word removal.
        try {
          const compressed = await compressAsset(audioBuffer);
          await saveCompressedAsset(assetId, compressed);
          void runTranscriptionPipeline(assetId, compressed);
        } catch (err) {
          console.error("[podcast-editor] Failed to compress generated clip for transcription", err);
        }

        const name = clipNameFromText(text);
        commit(
          (prev) =>
            prev.map((track) => {
              if (track.id !== trackId) return track;
              const startSample = resolveNonOverlappingStart(
                Math.round(insertionTimeSeconds * audioBuffer.sampleRate),
                audioBuffer.length,
                track.clips
              );
              const newClip = buildClipMeta(assetId, audioBuffer, startSample, name);
              return { ...track, clips: [...track.clips, newClip] };
            }),
          "Generate speech"
        );
        return true;
      } catch (err) {
        console.error("[podcast-editor] Speech generation failed", err);
        setError("Speech generation failed. Please try again.");
        return false;
      } finally {
        isGeneratingRef.current = false;
        setIsGenerating(false);
      }
    },
    [commit]
  );

  return { generateSpeech, isGenerating, error, dismissError: () => setError(null) };
}
