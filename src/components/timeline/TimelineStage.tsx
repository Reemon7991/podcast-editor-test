"use client";

import { useCallback, useState } from "react";
import { WaveformPlaylistProvider, type ClipTrack } from "@waveform-playlist/browser";
import { EditorShell } from "./EditorShell";
import { TRACK_WAVE_HEIGHT } from "../../utils/trackLayout";
import { dehydrate, hydrate } from "../../utils/clipHydration";
import type { TrackMeta } from "../../utils/types";

interface TimelineStageProps {
  tracks: TrackMeta[];
  onTracksChange: (tracks: TrackMeta[]) => void;
  onRemoveTrack: (trackIndex: number) => void;
  /** True while any clip is still decoding — defers the (expensive) Tone.js
   *  engine rebuild until the whole import batch settles, so adding several
   *  files doesn't trigger a rebuild per file. */
  deferEngineRebuild: boolean;
  onAddTrack: () => void;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
}

/** Engine-driven commit (trim/split, or ClipDragLayer's hand-applied moves)
 *  the provider itself last produced, kept alongside its dehydrated form so
 *  the *next* render can recognize "this is the same commit coming back
 *  around" and hand the engine its own array reference back unchanged,
 *  instead of paying for a fresh hydrate() that would defeat the provider's
 *  own `tracks === engineTracksRef.current` rebuild-avoidance check. See
 *  PERSISTENCE_UNDO_ORIGINAL_PLAN.md's "Confirmed library behavior" section.
 *
 *  Deliberately component state, not a ref: this project's ESLint config
 *  (eslint-plugin-react-hooks' `refs` rule) rejects reading `ref.current`
 *  during render at all, not just writing it — state is the idiomatic
 *  substitute for a value that's both written from an event/effect callback
 *  and read during render. `handleTracksChange` below sets this in the same
 *  synchronous tick as the `onTracksChange` call that updates the parent's
 *  own `tracks` state, so both batch into one re-render, not two. */
interface EngineOutputCache {
  dehydrated: TrackMeta[];
  raw: ClipTrack[];
}

export function TimelineStage({
  tracks,
  onTracksChange,
  onRemoveTrack,
  deferEngineRebuild,
  onAddTrack,
  onAddFilesToTrack,
  onDuplicateClip,
  onDeleteClip,
}: TimelineStageProps) {
  const [providerError, setProviderError] = useState<string | null>(null);
  const [lastEngineOutput, setLastEngineOutput] = useState<EngineOutputCache | null>(null);

  const hydratedTracks =
    lastEngineOutput?.dehydrated === tracks ? lastEngineOutput.raw : hydrate(tracks);

  // The sole choke point between the app's persisted/undo-safe TrackMeta[]
  // state and the hydrated ClipTrack[] shape WaveformPlaylistProvider needs
  // — see clipHydration.ts's own doc comment for why every other component
  // under this provider is unaffected by that split.
  const handleTracksChange = useCallback(
    (raw: ClipTrack[]) => {
      const dehydrated = dehydrate(raw);
      setLastEngineOutput({ dehydrated, raw });
      onTracksChange(dehydrated);
    },
    [onTracksChange]
  );

  if (providerError) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        Failed to build timeline: {providerError}
      </p>
    );
  }

  return (
    <WaveformPlaylistProvider
      tracks={hydratedTracks}
      onTracksChange={handleTracksChange}
      samplesPerPixel={1024}
      waveHeight={TRACK_WAVE_HEIGHT}
      mono
      timescale
      controls={{ show: true, width: 180 }}
      deferEngineRebuild={deferEngineRebuild}
      onError={(err) => setProviderError(err.message)}
    >
      <EditorShell
        onRemoveTrack={onRemoveTrack}
        onAddTrack={onAddTrack}
        onAddFilesToTrack={onAddFilesToTrack}
        onDuplicateClip={onDuplicateClip}
        onDeleteClip={onDeleteClip}
      />
    </WaveformPlaylistProvider>
  );
}
