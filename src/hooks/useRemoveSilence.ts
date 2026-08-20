"use client";

import { useCallback, useRef, useState } from "react";
import * as Tone from "tone";
import type { AudioClip } from "@waveform-playlist/browser";
import { getAssetId, hashFileBytes, registerAsset } from "../utils/assetRegistry";
import { saveAsset, saveCompressedAsset, saveTranscript } from "../utils/persistence";
import { spliceOutSilence } from "../utils/silenceDetection";
import { encodeWavPcm16 } from "../utils/wavEncode";
import { remapWordsThroughKeptRanges } from "../utils/transcriptRemap";
import { compressAsset } from "../utils/audioCompression";
import { runTranscriptionPipeline } from "../utils/transcription";
import type { AssetTranscript, ClipMeta } from "../utils/types";
import { useProjectStore } from "../store/projectStore";
import { useTranscriptStore } from "../store/transcriptStore";
import type { ToastMessage } from "../components/ui/Toast";

/**
 * Detects and splices out silence from a single clip — see
 * SILENCE_REMOVAL_PLAN.md for the full design. Mirrors useGenerateSpeech.ts's
 * shape: decode-or-compute, then a single commit() at the end.
 *
 * `isProcessingRef` is app-wide single-flight, not per-clip (same as
 * useGenerateSpeech.ts's isGeneratingRef). The caller (EditorShell.tsx) backs
 * this with a full-editor blocking overlay while `processingClipId !== null`,
 * same treatment as export's isExporting — ClipActionsOverlay.tsx's own
 * per-item disabled state on top of that is defense in depth, not the
 * primary guard anymore.
 *
 * `toast` is the transient "here's what just happened" outcome (succeeded /
 * no-op / failed) — auto-dismisses, see ui/Toast.tsx. `saveWarning` is kept
 * separate and non-auto-dismissing: a failed IndexedDB persist has a lasting
 * consequence (the trimmed clip won't survive a reload) that a 5-second
 * toast would undersell, so it uses the same persistent WarningBanner
 * pattern useTimelineTracks.ts's own saveWarning already established.
 */
export function useRemoveSilence() {
  const commit = useProjectStore((s) => s.commit);
  const [processingClipId, setProcessingClipId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const isProcessingRef = useRef(false);

  const removeSilence = useCallback(
    async (trackId: string, clip: AudioClip) => {
      if (clip.midiNotes) return; // audio-only feature; the menu item shouldn't offer this for a MIDI clip
      if (!clip.audioBuffer) return; // defensive — every clip reaching this menu is already hydrated
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setProcessingClipId(clip.id);
      try {
        // Yield to the browser once before the synchronous, CPU-bound RMS
        // scan + splice below. setProcessingClipId above only *schedules* a
        // re-render — React can't actually paint the overlay (or the menu
        // closing) until this function's own synchronous execution yields
        // back to the event loop, and spliceOutSilence blocks that yield on
        // anything but a tiny clip (confirmed directly: both the menu and
        // the overlay visibly waited on a real recording, only updating
        // once the scan had already finished). One macrotask tick is enough
        // for the browser to paint in between.
        await new Promise((resolve) => setTimeout(resolve, 0));

        const audioContext = Tone.getContext().rawContext as AudioContext;

        const result = spliceOutSilence(
          audioContext,
          clip.audioBuffer,
          clip.offsetSamples,
          clip.durationSamples
        );

        if (result.type === "unchanged") {
          setToast({ variant: "warning", text: "No silence detected in this clip." });
          return;
        }
        if (result.type === "all-silence") {
          setToast({ variant: "warning", text: "No audio detected above the silence threshold." });
          return;
        }

        const wavBlob = encodeWavPcm16(result.buffer);
        const arrayBuffer = await wavBlob.arrayBuffer();
        const assetId = await hashFileBytes(arrayBuffer);
        registerAsset(result.buffer, assetId);
        saveAsset(assetId, wavBlob).catch((err) => {
          console.error("[podcast-editor] Failed to persist silence-trimmed clip", err);
          setSaveWarning(
            "This clip's silence was removed, but couldn't be saved for offline use — it will be lost if you reload before exporting."
          );
        });

        // The splice mints a brand-new content-hash assetId with no
        // transcript of its own yet — see
        // TRANSCRIPTION_SEARCH_FILLER_WORDS_PLAN.md's Phase 4. If the
        // source clip's own asset already has a finished transcript, remap
        // it through the exact kept ranges this splice just used — no
        // network call, keeps this operation's existing "fully client-side"
        // property intact. Otherwise (source transcript still transcribing,
        // failed, or predates this feature) there's nothing to remap from,
        // so fall back to the same compress+transcribe pipeline a fresh
        // upload goes through, kicked off in the background exactly like a
        // normal upload's transcription — this operation's own toast/overlay
        // already cover the splice itself; this is a secondary, invisible
        // follow-up.
        // `clip` here is the hydrated AudioClip (has audioBuffer, not
        // assetId — that's a ClipMeta-only field, see utils/types.ts).
        // getAssetId resolves back via the same buffer-object-reference
        // binding registerAsset established at upload/hydration time.
        const sourceAssetId = getAssetId(clip.audioBuffer);
        const sourceTranscript = sourceAssetId
          ? useTranscriptStore.getState().transcripts[sourceAssetId]
          : undefined;
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
          compressAsset(result.buffer)
            .then(async (compressed) => {
              await saveCompressedAsset(assetId, compressed);
              void runTranscriptionPipeline(assetId, compressed);
            })
            .catch((err) => {
              console.error("[podcast-editor] Failed to compress silence-trimmed clip for transcription", err);
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
          name: clip.name ? `${clip.name} (silence removed)` : undefined,
          color: clip.color,
          fadeIn: result.leadingEdgeKept ? clip.fadeIn : undefined,
          fadeOut: result.trailingEdgeKept ? clip.fadeOut : undefined,
        };

        // Re-check the target still exists AND is unchanged immediately
        // before committing — this pipeline can run for a while on a large
        // clip, a bigger race window than any other commit() caller in this
        // app has. Read fresh via getState(), not a value closed over
        // earlier. Plain commit() (unlike commitEngineOutput) has no no-op
        // dedup, so committing against an already-gone/changed clip would
        // silently push a bad history entry instead of failing loudly.
        // Existence alone isn't enough: trimming/dragging the same clip is a
        // separate interaction path (ClipDragLayer.tsx) not gated by
        // isProcessingRef, so the clip could still exist but have different
        // boundaries than the ones this result was computed against.
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
              ? "This clip changed while silence was being removed — the result was discarded. Try again."
              : "This clip no longer exists — silence removal was discarded.",
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
          "Remove silence"
        );
        setToast({ variant: "success", text: "Silence removed." });
      } catch (err) {
        console.error("[podcast-editor] Silence removal failed", err);
        setToast({ variant: "error", text: "Silence removal failed. Please try again." });
      } finally {
        isProcessingRef.current = false;
        setProcessingClipId(null);
      }
    },
    [commit]
  );

  return {
    removeSilence,
    processingClipId,
    toast,
    dismissToast: () => setToast(null),
    saveWarning,
    dismissSaveWarning: () => setSaveWarning(null),
  };
}
