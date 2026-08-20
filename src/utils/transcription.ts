// Background transcription orchestration via AssemblyAI — submit once, poll
// until settled. See ASSEMBLYAI_TRANSCRIPTION_REFACTOR_PLAN.md. A plain
// module, not a hook: must be callable from useTimelineTracks.ts's
// addFilesToTrack, useGenerateSpeech.ts's generateSpeech, and
// useProjectHydration.ts's reload re-kick. Reads/writes transcriptStore.ts
// via getState()/setState() outside React, same pattern projectStore.ts
// uses for its own module-level stopIfPlaying.

import { useTranscriptStore } from "../store/transcriptStore";
import { saveTranscript } from "./persistence";
import type { AssetTranscript, TranscriptWord } from "./types";

const POLL_INTERVAL_MS = 3000;
// Safety net, not an expected outcome — AssemblyAI's own processing is much
// faster than the audio's real duration. 60 minutes of polling comfortably
// covers this app's target (2-3 hour podcasts) with margin. A transient
// status-check failure (network blip, our own server briefly down) rides
// this same budget rather than giving up early — the AssemblyAI job itself
// keeps running regardless of whether we're able to poll it right now.
const MAX_POLL_ATTEMPTS = 1200;
// Each poll fetch gets its own timeout — without one, a request that hangs
// (connection open, never responding) blocks the loop forever, silently
// bypassing the MAX_POLL_ATTEMPTS safety net entirely. 20s is generous
// against the server route's own 15s budget.
const POLL_FETCH_TIMEOUT_MS = 20_000;
// The submit request uploads the whole compressed asset — generous to cover
// a large multi-hour file over a slow connection, plus the server route's
// own retried upload+submit calls to AssemblyAI.
const SUBMIT_TIMEOUT_MS = 600_000;
const SUBMIT_RETRY_DELAY_MS = 1000;

interface StatusResult {
  status: "done" | "failed";
  words: TranscriptWord[] | null;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestSubmit(compressedBlob: Blob): Promise<Response> {
  const form = new FormData();
  form.append("file", compressedBlob, "audio.ogg");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
  try {
    return await fetch("/api/transcribe", { method: "POST", body: form, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** One retry on a network-level failure (dropped connection, timeout) — a
 *  large upload over a real-world connection has real odds of a transient
 *  blip. Not retried on a clean HTTP error response: the server route
 *  already retries its own AssemblyAI calls, so an error response back from
 *  it is a considered failure, not a transient one worth repeating. */
async function submit(compressedBlob: Blob): Promise<string> {
  let response: Response;
  try {
    response = await requestSubmit(compressedBlob);
  } catch (firstErr) {
    console.warn("[podcast-editor] Transcription submit request failed, retrying", firstErr);
    await sleep(SUBMIT_RETRY_DELAY_MS);
    try {
      response = await requestSubmit(compressedBlob);
    } catch (secondErr) {
      const reason = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`Transcription upload failed: ${reason}`);
    }
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Transcription request failed (${response.status})`);
  }
  const body = (await response.json()) as { transcriptId: string };
  return body.transcriptId;
}

async function pollOnce(providerJobId: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), POLL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`/api/transcribe/${providerJobId}`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Polls until the job settles. Never throws — exhausting MAX_POLL_ATTEMPTS
 * resolves to a "failed" StatusResult instead. A status-check failure
 * (network error, non-ok response) is treated the same as "still
 * transcribing" and simply retried next tick, but the reason is remembered:
 * if every recent attempt was a failure (not a genuine "still processing"
 * response), the eventual give-up message reflects that instead of a
 * generic, misleading "timed out" — a repeatedly-erroring server and a job
 * that's genuinely still processing after an hour are different problems
 * and shouldn't read the same to whoever sees the error.
 */
async function pollUntilSettled(providerJobId: string): Promise<StatusResult> {
  let lastFailureReason: string | undefined;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    try {
      const response = await pollOnce(providerJobId);
      if (response.ok) {
        const body = (await response.json()) as { status: string; words: TranscriptWord[] | null; error?: string };
        if (body.status === "done" || body.status === "failed") {
          return { status: body.status, words: body.words, error: body.error };
        }
        lastFailureReason = undefined; // a clean "still transcribing" response — the job and endpoint are healthy
      } else {
        lastFailureReason = `Status check failed (${response.status})`;
      }
    } catch (err) {
      lastFailureReason = err instanceof Error ? err.message : "Status check failed.";
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return {
    status: "failed",
    words: null,
    error: lastFailureReason
      ? `Transcription timed out after repeated status-check failures: ${lastFailureReason}`
      : "Transcription timed out.",
  };
}

async function pollAndPersist(assetId: string, providerJobId: string): Promise<void> {
  const result = await pollUntilSettled(providerJobId);
  const transcript: AssetTranscript = {
    assetId,
    status: result.status,
    words: result.words,
    error: result.error,
    providerJobId,
    updatedAt: Date.now(),
  };
  useTranscriptStore.getState().setTranscript(transcript);
  await saveTranscript(transcript).catch((err) => {
    console.error("[podcast-editor] Failed to persist transcript to IndexedDB", err);
  });
}

/**
 * Submits a compressed asset for transcription and polls until it settles.
 * Never throws — every outcome (success, submit failure, poll failure) is
 * represented in the written AssetTranscript instead.
 */
export async function runTranscriptionPipeline(assetId: string, compressedBlob: Blob): Promise<void> {
  const { setTranscript } = useTranscriptStore.getState();

  let providerJobId: string;
  try {
    providerJobId = await submit(compressedBlob);
  } catch (err) {
    const transcript: AssetTranscript = {
      assetId,
      status: "failed",
      words: null,
      error: err instanceof Error ? err.message : "Transcription failed.",
      updatedAt: Date.now(),
    };
    setTranscript(transcript);
    await saveTranscript(transcript).catch((saveErr) => {
      console.error("[podcast-editor] Failed to persist transcript to IndexedDB", saveErr);
    });
    return;
  }

  const transcribing: AssetTranscript = {
    assetId,
    status: "transcribing",
    words: null,
    providerJobId,
    updatedAt: Date.now(),
  };
  setTranscript(transcribing);
  // Awaited, not fire-and-forget — closes a real (if narrow) race: without
  // this, a tab closed in the brief window before the write lands would
  // leave no persisted "transcribing" record at all, and
  // useProjectHydration.ts's reload re-kick has nothing to resume from (its
  // own guard requires a transcript to already exist).
  await saveTranscript(transcribing).catch((err) => {
    console.error("[podcast-editor] Failed to persist transcript to IndexedDB", err);
  });

  await pollAndPersist(assetId, providerJobId);
}

/**
 * Resumes polling an already-submitted job — used by
 * useProjectHydration.ts's reload re-kick, so a tab closed mid-transcription
 * doesn't submit a duplicate AssemblyAI job on the next load.
 */
export async function resumeTranscriptionPipeline(assetId: string, providerJobId: string): Promise<void> {
  await pollAndPersist(assetId, providerJobId);
}
