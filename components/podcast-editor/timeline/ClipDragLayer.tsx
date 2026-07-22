"use client";

import { useCallback, useRef, type ComponentProps, type ReactNode, type RefObject } from "react";
import { DragDropProvider } from "@dnd-kit/react";
import { constrainClipDrag } from "@waveform-playlist/engine";
import type { AudioClip, ClipTrack } from "@waveform-playlist/browser";
import {
  ClipInteractionProvider,
  usePlaybackAnimation,
  usePlaylistData,
  usePlaylistControls,
  useClipDragHandlers,
  useDragSensors,
  noDropAnimationPlugins,
} from "@waveform-playlist/browser";
import { TRACK_ROW_HEIGHT_PX } from "./trackLayout";

interface ClipSourceData {
  trackIndex: number;
  clipIndex: number;
  clipId: string;
  boundary?: "left" | "right";
}

interface ClipDragLayerProps {
  children: ReactNode;
  /** True for the duration of an in-flight PlayButton `play()` call (see
   *  transport/PlayButton.tsx). The library's own `play()` re-reads its
   *  engine ref after an internal `await engine.init()` instead of using a
   *  captured reference — if a drop lands mid-await and triggers an engine
   *  rebuild, `play()` resumes against the new (uninitialized) engine and
   *  throws "TonePlayout not initialized". Not patchable from here (the race
   *  is inside vendored/bundled library code), so onDragEnd instead refuses
   *  to commit a move while this flag is set, closing the trigger instead of
   *  the symptom. */
  playPendingRef: RefObject<boolean>;
}

// Derived from DragDropProvider's own prop types rather than dnd-kit's
// generic DragStartEvent/DragEndEvent aliases directly — those carry default
// type params that don't resolve cleanly through Parameters<> here.
type DragDropProviderProps = ComponentProps<typeof DragDropProvider>;
type OnDragStart = NonNullable<DragDropProviderProps["onDragStart"]>;
type OnDragEnd = NonNullable<DragDropProviderProps["onDragEnd"]>;
type DragStartEventArg = Parameters<OnDragStart>[0];
type DragEndEventArg = Parameters<OnDragEnd>[0];

// useClipDragHandlers' own return type has the same unresolved-generic issue
// internally (its handlers type to `(event: never) => void`), so calling
// them with our concretely-typed event needs a narrow escape hatch here —
// this is a type-only mismatch in the library's .d.ts, not a runtime one.
type LibraryDragHandler = (event: never) => void;

/**
 * Finds where `clip` actually lands if dropped at `proposedStartSample`
 * among `otherClips` (the target track's clips, excluding this one), and
 * clamps only enough to avoid overlapping whichever clip ends up adjacent to
 * that *proposed* position.
 *
 * This is deliberately not engine.moveClip()'s approach: that constrains
 * movement relative to the clip's neighbors *at drag-start*, computed once
 * and held fixed — so a clip can only slide within its current gap and can
 * never cross a neighbor to reorder past it. Anchoring the neighbor lookup
 * to the proposed drop position instead (via constrainClipDrag with a zero
 * delta, reusing the engine's own overlap math) allows a clip to be dropped
 * before an earlier clip, same as dragging it to any other open slot.
 */
function resolveDropPosition(
  clip: AudioClip,
  proposedStartSample: number,
  otherClips: AudioClip[]
): number {
  const proposedClip = { ...clip, startSample: Math.max(0, proposedStartSample) };
  const merged = [...otherClips, proposedClip].sort(
    (a, b) => a.startSample - b.startSample
  );
  const mergedIndex = merged.findIndex((c) => c.id === clip.id);
  const constrainedDelta = constrainClipDrag(proposedClip, 0, merged, mergedIndex);
  return Math.max(0, Math.floor(proposedClip.startSample + constrainedDelta));
}

/**
 * Enables clip dragging with cross-track support and free reordering within
 * a track.
 *
 * The library's own ClipInteractionProvider is a turnkey drag layer, but it
 * unconditionally applies a horizontal-axis restriction, and its onDragEnd
 * delegates to engine.moveClip() — which, as above, only lets a clip slide
 * within its current gap and has no cross-track primitive at all. Whether a
 * clip renders as draggable is gated by an internal context flag that only
 * ClipInteractionProvider can set (it isn't exported), so we keep it mounted
 * for that side effect and nest our own DragDropProvider inside it.
 * Draggables always bind to the nearest DragDropProvider ancestor, so ours
 * takes over the actual interaction — ClipInteractionProvider's own outer
 * one ends up with nothing registered.
 *
 * Every clip *move* (same-track reorder or cross-track) goes through
 * resolveDropPosition and is applied by reassigning the tracks array
 * directly via onTracksChange — the same "external update" path used
 * everywhere else in this app (import, remove, add track). Boundary trims
 * and cancelled drags are untouched and still delegate to the library.
 */
export function ClipDragLayer({ children, playPendingRef }: ClipDragLayerProps) {
  return (
    <ClipInteractionProvider>
      <CrossTrackDragProvider playPendingRef={playPendingRef}>
        {children}
      </CrossTrackDragProvider>
    </ClipInteractionProvider>
  );
}

function CrossTrackDragProvider({ children, playPendingRef }: ClipDragLayerProps) {
  const { tracks, samplesPerPixel, playoutRef, isDraggingRef, onTracksChange } =
    usePlaylistData();
  const { setSelectedTrackId, scrollContainerRef, stop } = usePlaylistControls();
  const { isPlaying } = usePlaybackAnimation();
  const sensors = useDragSensors();

  // dnd-kit's auto-scroll (@dnd-kit/dom's Scroller plugin) moves the
  // container by mutating `element.scrollLeft` directly — it never touches
  // the drag operation's own position/transform, which stays pure
  // pointer-coordinate delta throughout. So if a drag auto-scrolls (or the
  // container scrolls at all mid-drag), transform.x alone under-reports how
  // far the drop target actually moved in content space, and the collision
  // clamp below silently snaps the clip back near its original neighbors —
  // this is why reordering "does nothing" once a drag needs to scroll to
  // reach its target. Capturing scrollLeft at drag start and folding its
  // delta into the sample math at drop time corrects for it.
  const dragStartScrollLeftRef = useRef(0);

  const {
    onDragStart: libraryOnDragStart,
    onDragMove,
    onDragEnd: libraryOnDragEnd,
  } = useClipDragHandlers({
    tracks,
    onTracksChange: onTracksChange ?? (() => {}),
    samplesPerPixel,
    engineRef: playoutRef,
    isDraggingRef,
  });

  const onDragStart = useCallback(
    (event: DragStartEventArg) => {
      dragStartScrollLeftRef.current = scrollContainerRef.current?.scrollLeft ?? 0;
      const data = event.operation?.source?.data as ClipSourceData | undefined;
      if (data && tracks[data.trackIndex]) {
        setSelectedTrackId(tracks[data.trackIndex].id);
      }
      (libraryOnDragStart as LibraryDragHandler)(event as never);
    },
    [libraryOnDragStart, tracks, setSelectedTrackId, scrollContainerRef]
  );

  const onDragEnd = useCallback(
    (event: DragEndEventArg) => {
      const data = event.operation?.source?.data as ClipSourceData | undefined;

      // Trims and cancelled drags are entirely the library's concern. A move
      // landing while a play() call is mid-await on engine.init() is treated
      // the same way — see the playPendingRef doc comment on this component.
      if (event.canceled || !data || data.boundary || playPendingRef.current) {
        (libraryOnDragEnd as LibraryDragHandler)(event as never);
        return;
      }

      const sourceTrackIndex = data.trackIndex;
      // `position` is the raw pointer delta, unaffected by any modifier —
      // unlike `transform`, which a horizontal-only modifier would zero on Y.
      const rawDeltaY =
        event.operation.position.current.y - event.operation.position.initial.y;
      const deltaRows = Math.round(rawDeltaY / TRACK_ROW_HEIGHT_PX);
      const targetTrackIndex = Math.min(
        Math.max(sourceTrackIndex + deltaRows, 0),
        tracks.length - 1
      );

      const sourceTrack = tracks[sourceTrackIndex];
      const targetTrack = tracks[targetTrackIndex];
      const clip = sourceTrack?.clips[data.clipIndex];
      if (!clip || !targetTrack) {
        playoutRef.current?.abortTransaction();
        isDraggingRef.current = false;
        return;
      }

      const scrollDeltaPx =
        (scrollContainerRef.current?.scrollLeft ?? dragStartScrollLeftRef.current) -
        dragStartScrollLeftRef.current;
      const sampleDelta =
        (event.operation.transform.x + scrollDeltaPx) * samplesPerPixel;
      const proposedStartSample = clip.startSample + sampleDelta;
      const otherClips = targetTrack.clips.filter((c) => c.id !== clip.id);
      const newStartSample = resolveDropPosition(
        clip,
        proposedStartSample,
        otherClips
      );

      const newTracks: ClipTrack[] = tracks.map((track, index) => {
        if (index === sourceTrackIndex && index === targetTrackIndex) {
          return {
            ...track,
            clips: [
              ...otherClips,
              { ...clip, startSample: newStartSample },
            ],
          };
        }
        if (index === sourceTrackIndex) {
          return { ...track, clips: track.clips.filter((c) => c.id !== clip.id) };
        }
        if (index === targetTrackIndex) {
          return {
            ...track,
            clips: [...track.clips, { ...clip, startSample: newStartSample }],
          };
        }
        return track;
      });

      // Committing a move while playing hands the provider's own auto-resume-
      // after-rebuild logic, which has the same check-then-act race as the
      // play()/rebuild one above but fires unconditionally (100% reproducible,
      // not timing-dependent) — see CLAUDE.md's "editing while already
      // playing" section for the full trace. `stop()` is synchronous, so
      // calling it here batches with the state update below into one commit,
      // and the rebuild effect never sees playback as active.
      if (isPlaying) {
        stop();
      }

      // No engine.moveClip()/trimClip() call was made on this transaction —
      // discard it rather than leave it open for the next operation.
      playoutRef.current?.abortTransaction();
      isDraggingRef.current = false;
      onTracksChange?.(newTracks);
    },
    [
      tracks,
      onTracksChange,
      samplesPerPixel,
      playoutRef,
      isDraggingRef,
      playPendingRef,
      scrollContainerRef,
      isPlaying,
      stop,
      libraryOnDragEnd,
    ]
  );

  return (
    <DragDropProvider
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove as unknown as DragDropProviderProps["onDragMove"]}
      onDragEnd={onDragEnd}
      plugins={noDropAnimationPlugins}
    >
      {children}
    </DragDropProvider>
  );
}
