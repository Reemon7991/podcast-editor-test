import type { AudioClip, ClipTrack } from "@waveform-playlist/browser";

/**
 * Persistence/undo-safe clip shape — everything AudioClip has except the
 * decoded `audioBuffer` (large, session-scoped, never cloned/serialized),
 * replaced by `assetId`: a lookup key into ./assetRegistry.ts. See
 * PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Core mechanism" section.
 *
 * AudioClip also has an optional `waveformData` field for a peaks-first
 * rendering flow this app doesn't use — nothing here ever sets it, so
 * there's nothing to strip from this type.
 */
export type ClipMeta = Omit<AudioClip, "audioBuffer"> & { assetId: string };

export type TrackMeta = Omit<ClipTrack, "clips"> & { clips: ClipMeta[] };
