"use client";

import { useCallback, useRef, useState } from "react";
import * as Tone from "tone";
import type { AudioClip } from "@waveform-playlist/browser";
import { getAssetId, hashFileBytes, registerAsset } from "../utils/assetRegistry";
import { saveAsset, saveCompressedAsset, saveTranscript } from "../utils/persistence";
import { spliceKeepRanges, type KeepRange } from "../utils/clipSplice";
import { detectFillerWords, summarizeFillerWordMatches, type FillerWordSummaryEntry } from "../utils/fillerWordDetection";
import { encodeWavPcm16 } from "../utils/wavEncode";
import { remapWordsThroughKeptRanges } from "../utils/transcriptRemap";
import { compressAssetToChunks } from "../utils/audioCompression";
import { runTranscriptionPipeline } from "../utils/transcription";
import type { AssetTranscript, ClipMeta } from "../utils/types";
import { useProjectStore } from "../store/projectStore";
import { useTranscriptStore } from "../store/transcriptStore";
import type { ToastMessage } from "../components/ui/Toast";

export interface PendingFillerWordRemoval {
  trackId: string;
  clip: AudioClip;
  // Narrowed AudioBuffer (clip.audioBuffer is optional) — avoids a `!`
  // assertion later in confirmPending.
  audioBuffer: AudioBuffer;
  summary: FillerWordSummaryEntry[];
  totalCount: number;
}

/**
 * Detects and splices out filler words ("um", "uh", "erm", "ah" — see
 * utils/fillerWords.ts) from a single clip, in two steps: detectForClip()
 * scans the clip's already-finished transcript (cheap — no audio touched
 * yet) and populates `pending` with a count summary; confirm() actually
 * splices and commits, cancel() discards. See
 * TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 6.
 *
 * Deliberately mirrors useRemoveSilence.ts's shape point-for-point beyond
 * the extra detect/confirm split — same app-wide single-flight guard, same
 * paint-before-CPU-bound-work yield, same live-boundary re-check
 * immediately before committing, same transcript-remap-over-re-transcribe
 * behavior for the spliced result, same toast/processingClipId contract —
 * so EditorShell.tsx can wire this in exactly like that hook already is.
 */
export function useFillerWordRemoval() {
  const commit = useProjectStore((s) => s.commit);
  const [pending, setPending] = useState<PendingFillerWordRemoval | null>(null);
  const [processingClipId, setProcessingClipId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const isProcessingRef = useRef(false);
  // The keepRanges computed alongside `pending` — kept in a ref (not
  // re-derived from `pending`) since it's not itself renderable state, just
  // a value confirm() needs. Guarded by clipId at confirm time so a stale
  // ref can never be applied against a different clip.
  const pendingKeepRangesRef = useRef<{ clipId: string; keepRanges: KeepRange[] } | null>(null);

  /** Scans `clip`'s transcript for filler words and opens the confirmation
   *  summary — or, if none are found, shows the same "nothing to do" toast
   *  silence removal's own no-op path uses. Synchronous and cheap (only
   *  reads already-finished transcript words, touches no audio), so unlike
   *  confirm() below this never sets processingClipId/shows the blocking
   *  overlay. */
  const detectForClip = useCallback((trackId: string, clip: AudioClip) => {
    const audioBuffer = clip.audioBuffer;
    if (clip.midiNotes || !audioBuffer) return; // audio-only feature, same guard useRemoveSilence.ts applies
    if (isProcessingRef.current) return;
    const assetId = getAssetId(audioBuffer);
    const transcript = assetId ? useTranscriptStore.getState().transcripts[assetId] : undefined;
    // Defensive — the menu item that calls this is already disabled unless
    // the transcript is "done" (see ClipActionsOverlay.tsx's buildActions).
    if (!transcript || transcript.status !== "done" || !transcript.words) return;

    const { matches, keepRanges } = detectFillerWords(transcript.words, clip.offsetSamples, clip.durationSamples, clip.sampleRate);
    if (matches.length === 0) {
      setToast({ variant: "warning", text: "No filler words detected in this clip." });
      return;
    }
    pendingKeepRangesRef.current = { clipId: clip.id, keepRanges };
    setPending({ trackId, clip, audioBuffer, summary: summarizeFillerWordMatches(matches), totalCount: matches.length });
  }, []);

  const cancelPending = useCallback(() => {
    setPending(null);
    pendingKeepRangesRef.current = null;
  }, []);

  const confirmPending = useCallback(async () => {
    const current = pending;
    const keepRangeEntry = pendingKeepRangesRef.current;
    if (!current || !keepRangeEntry || keepRangeEntry.clipId !== current.clip.id) return;
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setProcessingClipId(current.clip.id);
    setPending(null);
    try {
      // Same paint-before-CPU-bound-work yield useRemoveSilence.ts uses —
      // lets the blocking overlay actually paint before the splice below
      // (a synchronous block over real audio data) runs.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const { trackId, clip, audioBuffer } = current;
      const audioContext = Tone.getContext().rawContext as AudioContext;
      const result = spliceKeepRanges(
        audioContext,
        audioBuffer,
        clip.offsetSamples,
        clip.durationSamples,
        keepRangeEntry.keepRanges
      );

      if (result.type === "unchanged") {
        // Shouldn't normally happen (confirm only reachable after
        // detectForClip found matches) — defensive in case the clip somehow
        // changed underneath the confirmation summary.
        setToast({ variant: "warning", text: "No filler words detected in this clip." });
        return;
      }
      if (result.type === "removed-all") {
        setToast({ variant: "warning", text: "That would remove the entire clip — nothing was changed." });
        return;
      }

      const wavBlob = encodeWavPcm16(result.buffer);
      const arrayBuffer = await wavBlob.arrayBuffer();
      const assetId = await hashFileBytes(arrayBuffer);
      registerAsset(result.buffer, assetId);
      saveAsset(assetId, wavBlob).catch((err) => {
        console.error("[podcast-editor] Failed to persist filler-word-trimmed clip", err);
        setSaveWarning(
          "This clip's filler words were removed, but the result couldn't be saved for offline use — it will be lost if you reload before exporting."
        );
      });

      // Remap the source transcript through this splice's own kept ranges,
      // exactly like useRemoveSilence.ts's Phase 4 remap — no network call
      // needed when the source already has a finished transcript to remap
      // from. Falls back to a real transcription pass only if it doesn't.
      const sourceAssetId = getAssetId(audioBuffer);
      const sourceTranscript = sourceAssetId ? useTranscriptStore.getState().transcripts[sourceAssetId] : undefined;
      if (sourceTranscript?.status === "done" && sourceTranscript.words) {
        const remappedWords = remapWordsThroughKeptRanges(
          sourceTranscript.words,
          clip.offsetSamples,
          clip.durationSamples,
          clip.sampleRate,
          result.keepRanges
        );
        const newTranscript: AssetTranscript = {
          assetId,
          status: "done",
          words: remappedWords,
          updatedAt: Date.now(),
        };
        useTranscriptStore.getState().setTranscript(newTranscript);
        saveTranscript(newTranscript).catch((err) => {
          console.error("[podcast-editor] Failed to persist remapped transcript", err);
        });
      } else {
        compressAssetToChunks(audioContext, result.buffer)
          .then(async (chunks) => {
            await saveCompressedAsset(assetId, chunks);
            void runTranscriptionPipeline(assetId, chunks, result.buffer.sampleRate);
          })
          .catch((err) => {
            console.error("[podcast-editor] Failed to compress filler-word-trimmed clip for transcription", err);
          });
      }

      const newClip: ClipMeta = {
        id: crypto.randomUUID(),
        assetId,
        startSample: clip.startSample, // clip does not move on the timeline
        durationSamples: result.buffer.length,
        offsetSamples: 0,
        sampleRate: result.buffer.sampleRate,
        sourceDurationSamples: result.buffer.length,
        gain: clip.gain,
        name: clip.name ? `${clip.name} (filler words removed)` : undefined,
        color: clip.color,
        fadeIn: result.leadingEdgeKept ? clip.fadeIn : undefined,
        fadeOut: result.trailingEdgeKept ? clip.fadeOut : undefined,
      };

      // Re-check the target still exists AND is unchanged immediately
      // before committing — same race guard useRemoveSilence.ts applies
      // (trimming/dragging the same clip is a separate interaction path not
      // gated by isProcessingRef, so it could still exist but have
      // different boundaries than the ones this result was computed
      // against).
      const liveTrack = useProjectStore.getState().present.find((t) => t.id === trackId);
      const liveClip = liveTrack?.clips.find((c) => c.id === clip.id);
      const unchanged =
        liveClip !== undefined &&
        liveClip.offsetSamples === clip.offsetSamples &&
        liveClip.durationSamples === clip.durationSamples &&
        liveClip.startSample === clip.startSample;
      if (!unchanged) {
        setToast({
          variant: "error",
          text: liveClip
            ? "This clip changed while filler words were being removed — the result was discarded. Try again."
            : "This clip no longer exists — filler-word removal was discarded.",
        });
        return;
      }

      commit(
        (prev) =>
          prev.map((track) =>
            track.id === trackId
              ? { ...track, clips: track.clips.map((c) => (c.id === clip.id ? newClip : c)) }
              : track
          ),
        "Remove filler words"
      );
      setToast({
        variant: "success",
        text: current.totalCount === 1 ? "1 filler word removed." : `${current.totalCount} filler words removed.`,
      });
    } catch (err) {
      console.error("[podcast-editor] Filler-word removal failed", err);
      setToast({ variant: "error", text: "Filler-word removal failed. Please try again." });
    } finally {
      isProcessingRef.current = false;
      setProcessingClipId(null);
      pendingKeepRangesRef.current = null;
    }
  }, [pending, commit]);

  return {
    detectForClip,
    pending,
    cancelPending,
    confirmPending,
    processingClipId,
    toast,
    dismissToast: () => setToast(null),
    saveWarning,
    dismissSaveWarning: () => setSaveWarning(null),
  };
}
