"use client";

import { useCallback, useRef, useState } from "react";
import * as Tone from "tone";
import type { AudioClip } from "@waveform-playlist/browser";
import { hashFileBytes, registerAsset } from "../utils/assetRegistry";
import { saveAsset } from "../utils/persistence";
import { extractClipAudio } from "../utils/audioBufferSlice";
import { encodeWavPcm16 } from "../utils/wavEncode";
import type { ClipMeta } from "../utils/types";
import { useProjectStore } from "../store/projectStore";
import type { ToastMessage } from "../components/ui/Toast";

const POLL_INTERVAL_MS = 3000;
// Bounds how long a single job is polled before giving up client-side — the
// Replicate prediction itself may still finish server-side after this, but
// nothing polls it again (see NOISE_REDUCTION_PLAN.md's disclosed gaps).
// Generous relative to resemble-enhance's own ~70-80s typical run time.
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

type JobStatus = "starting" | "processing" | "succeeded" | "failed" | "canceled";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a single clip's audio out for Replicate-based noise reduction and
 * replaces the clip in place on success — see NOISE_REDUCTION_PLAN.md. Near-
 * direct copy of useRemoveSilence.ts's shape (single processingClipId +
 * isProcessingRef, app-wide single-flight, not per-clip — "Reduce noise"
 * disables on every clip's menu the moment one job starts), adapted for a
 * multi-step async job (create -> poll -> fetch result) instead of one
 * synchronous local computation.
 *
 * Lives in EditorShell.tsx (not lifted to PodcastEditor.tsx) for the exact
 * reason useRemoveSilence.ts's own doc comment already gives there: this
 * hook's state changes independently of any store commit() — most of a
 * job's ~70-80s lifetime is spent polling, committing nothing at all — and
 * EditorShell sits below TimelineStage, the one place a prop that changes on
 * its own doesn't force a spurious full engine rebuild on every unrelated
 * render (TimelineStage's own passthrough-cache/hydrate() staleness issue,
 * see CLAUDE.md's "Silence removal" section for the full trace).
 */
export function useNoiseReduction() {
  const commit = useProjectStore((s) => s.commit);
  const [processingClipId, setProcessingClipId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const isProcessingRef = useRef(false);

  const reduceNoise = useCallback(
    async (trackId: string, clip: AudioClip) => {
      if (clip.midiNotes) return; // audio-only feature, same gate remove-silence uses
      if (!clip.audioBuffer) return; // defensive — every clip reaching this menu is already hydrated
      if (isProcessingRef.current) return;
      isProcessingRef.current = true;
      setProcessingClipId(clip.id);
      try {
        const audioContext = Tone.getContext().rawContext as AudioContext;
        const clipAudio = extractClipAudio(
          audioContext,
          clip.audioBuffer,
          clip.offsetSamples,
          clip.durationSamples
        );
        const wavBlob = encodeWavPcm16(clipAudio);

        const formData = new FormData();
        formData.append("audio", wavBlob, "clip.wav");
        const createResponse = await fetch("/api/noise-reduction", { method: "POST", body: formData });
        if (!createResponse.ok) {
          const body = (await createResponse.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Noise reduction failed to start.");
        }
        const { jobId } = (await createResponse.json()) as { jobId: string };

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let status: JobStatus = "starting";
        while (status === "starting" || status === "processing") {
          if (Date.now() > deadline) throw new Error("Noise reduction timed out.");
          await sleep(POLL_INTERVAL_MS);
          const statusResponse = await fetch(`/api/noise-reduction/${jobId}`);
          if (!statusResponse.ok) throw new Error("Failed to check noise reduction status.");
          const statusBody = (await statusResponse.json()) as { status: JobStatus; error?: string };
          status = statusBody.status;
          if (status === "failed" || status === "canceled") {
            throw new Error(statusBody.error ?? "Noise reduction failed.");
          }
        }

        const resultResponse = await fetch(`/api/noise-reduction/${jobId}/result`);
        if (!resultResponse.ok) throw new Error("Failed to fetch noise reduction result.");
        const arrayBuffer = await resultResponse.arrayBuffer();
        // Same ordering useGenerateSpeech.ts already establishes and
        // documents: Blob-wrap and hash *before* decodeAudioData, not after
        // — some engines have historically detached the ArrayBuffer passed
        // to decodeAudioData.
        const resultBlob = new Blob([arrayBuffer], { type: "audio/wav" });
        const assetId = await hashFileBytes(arrayBuffer);
        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
        registerAsset(decodedBuffer, assetId);
        saveAsset(assetId, resultBlob).catch((err) => {
          console.error("[podcast-editor] Failed to persist noise-reduced clip", err);
          setSaveWarning(
            "This clip's noise was reduced, but couldn't be saved for offline use — it will be lost if you reload before exporting."
          );
        });

        // Live-clip recheck, adapted for a job that can run for a couple of
        // minutes: unlike useRemoveSilence.ts's stricter version (which also
        // requires startSample to be unchanged), a plain *move* — dragging
        // this same clip to a new position, same trimmed content — is a
        // realistic thing to do to some other clip while a job runs and
        // shouldn't discard an already-paid-for result. Only a changed
        // trim/offset or the clip's own deletion does. Read fresh via
        // getState(), never a value closed over earlier — same reasoning
        // useRemoveSilence.ts's own doc comment gives for this pattern.
        const liveTrack = useProjectStore.getState().present.find((t) => t.id === trackId);
        const liveClip = liveTrack?.clips.find((c) => c.id === clip.id);
        const contentUnchanged =
          liveClip !== undefined &&
          liveClip.offsetSamples === clip.offsetSamples &&
          liveClip.durationSamples === clip.durationSamples;
        if (!contentUnchanged || !liveClip) {
          setToast({
            variant: "error",
            text: liveClip
              ? "This clip changed while noise reduction was running — the result was discarded. Try again."
              : "This clip no longer exists — noise reduction was discarded.",
          });
          return;
        }

        // The model's output can come back a handful of samples off from
        // what was sent (typical for a diffusion-based vocoder like
        // resemble-enhance) — comparing decodedBuffer.length against the
        // *sent* duration (clip.durationSamples, not liveClip's — the
        // recheck above already confirmed those two are equal) catches
        // that. Preserving fadeIn/fadeOut in that case would subtly
        // misalign them from the clip's new edges, so both are dropped
        // together rather than guessing — conservative, same spirit as
        // silence removal's own edge-based fade gating, just simpler since
        // there's no leading/trailing-edge distinction here.
        const outputDurationMatchesInput = decodedBuffer.length === clip.durationSamples;
        const newClip: ClipMeta = {
          id: crypto.randomUUID(),
          assetId,
          startSample: liveClip.startSample, // current position, not the one captured when the job started — tolerates a plain move
          durationSamples: decodedBuffer.length,
          offsetSamples: 0,
          sampleRate: decodedBuffer.sampleRate,
          sourceDurationSamples: decodedBuffer.length,
          gain: liveClip.gain,
          name: liveClip.name ? `${liveClip.name} (noise reduced)` : undefined,
          color: liveClip.color,
          fadeIn: outputDurationMatchesInput ? liveClip.fadeIn : undefined,
          fadeOut: outputDurationMatchesInput ? liveClip.fadeOut : undefined,
        };

        commit(
          (prev) =>
            prev.map((track) =>
              track.id === trackId
                ? { ...track, clips: track.clips.map((c) => (c.id === clip.id ? newClip : c)) }
                : track
            ),
          "Reduce noise"
        );
        setToast({ variant: "success", text: "Noise reduced." });
      } catch (err) {
        console.error("[podcast-editor] Noise reduction failed", err);
        setToast({ variant: "error", text: "Noise reduction failed. Please try again." });
      } finally {
        isProcessingRef.current = false;
        setProcessingClipId(null);
      }
    },
    [commit]
  );

  return {
    reduceNoise,
    processingClipId,
    toast,
    dismissToast: () => setToast(null),
    saveWarning,
    dismissSaveWarning: () => setSaveWarning(null),
  };
}
