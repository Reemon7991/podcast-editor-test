"use client";

import { useCallback, useState } from "react";
import { WaveformPlaylistProvider, type ClipTrack } from "@waveform-playlist/browser";
import { EditorShell } from "./EditorShell";
import { TRACK_WAVE_HEIGHT } from "../../utils/trackLayout";
import { dehydrate, hydrate } from "../../utils/clipHydration";
import { useProjectStore } from "../../store/projectStore";
import {
  waveformTheme,
  WAVEFORM_BAR_WIDTH,
  WAVEFORM_BAR_GAP,
  WAVEFORM_ROUNDED_BARS,
} from "../../theme/waveformTheme";

interface TimelineStageProps {
  /** Undefined hides every track's close button — used when only one track
   *  remains, since a podcast needs at least one. See PodcastEditor.tsx. */
  onRemoveTrack: ((trackIndex: number) => void) | undefined;
  /** True while any clip is still decoding — defers the (expensive) Tone.js
   *  engine rebuild until the whole import batch settles, so adding several
   *  files doesn't trigger a rebuild per file. */
  deferEngineRebuild: boolean;
  onAddTrack: () => void;
  onAddFilesToTrack: (trackId: string, files: File[], insertionTimeSeconds: number) => void;
  onDuplicateClip: (trackId: string, clipId: string) => void;
  onDeleteClip: (trackId: string, clipId: string) => void;
}

export function TimelineStage({
  onRemoveTrack,
  deferEngineRebuild,
  onAddTrack,
  onAddFilesToTrack,
  onDuplicateClip,
  onDeleteClip,
}: TimelineStageProps) {
  const [providerError, setProviderError] = useState<string | null>(null);
  const tracks = useProjectStore((s) => s.present);
  const lastEngineOutput = useProjectStore((s) => s.lastEngineOutput);
  const commitEngineOutput = useProjectStore((s) => s.commitEngineOutput);

  // The passthrough cache (lastEngineOutput) lives in the project store, not
  // component state here — see projectStore.ts's own doc comment on
  // EngineOutputCache for why colocating it with `present` in one atomic
  // store update is load-bearing, not just tidiness.
  const hydratedTracks =
    lastEngineOutput?.dehydrated === tracks ? lastEngineOutput.raw : hydrate(tracks);

  // The sole choke point between the app's persisted/undo-safe TrackMeta[]
  // state and the hydrated ClipTrack[] shape WaveformPlaylistProvider needs
  // — see clipHydration.ts's own doc comment for why every other component
  // under this provider is unaffected by that split. This callback only ever
  // receives *settled* engine-driven updates (trim/split's actual commit,
  // ClipDragLayer's hand-applied moves, the incremental-add mirror) — live
  // trim-preview frames are intercepted earlier, in ClipDragLayer.tsx (see
  // its own doc comment), so every call here is safe to push to undo history
  // under one generic "Edit timeline" label — this is the fan-in point for
  // several distinct mutation kinds, no cheap way to distinguish which one
  // just happened here, and labels are cosmetic only (see
  // PERSISTENCE_UNDO_ORIGINAL_PLAN.md's Phase 2).
  const handleTracksChange = useCallback(
    (raw: ClipTrack[]) => {
      commitEngineOutput(raw, dehydrate(raw));
    },
    [commitEngineOutput]
  );

  if (providerError) {
    return (
      <p className="text-sm text-red-600">
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
      theme={waveformTheme}
      barWidth={WAVEFORM_BAR_WIDTH}
      barGap={WAVEFORM_BAR_GAP}
      roundedBars={WAVEFORM_ROUNDED_BARS}
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
