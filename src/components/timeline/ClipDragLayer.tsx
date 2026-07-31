"use client";

import { useCallback, useState, useRef, type ComponentProps, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import { DragDropProvider } from "@dnd-kit/react";
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
import { TRACK_ROW_HEIGHT_PX } from "../../utils/trackLayout";
import { dehydrate } from "../../utils/clipHydration";
import { resolveNonOverlappingStart, resolveClipAt } from "../../utils/clipGeometry";
import { useProjectStore } from "../../store/projectStore";
import { ClipSwapConfirmPopover } from "./ClipSwapConfirmPopover";

interface ClipSourceData {
  trackIndex: number;
  clipIndex: number;
  clipId: string;
  boundary?: "left" | "right";
}

interface PendingSwap {
  trackId: string;
  clipId: string;
  neighborId: string;
  side: NeighborSide;
  clipName?: string;
  neighborName?: string;
  anchor: { x: number; y: number };
}

interface ClipDragLayerProps {
  children: ReactNode;
  /** True for the duration of an in-flight PlayPauseButton `play()` call (see
   *  transport/PlayPauseButton.tsx). The library's own `play()` re-reads its
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

type NeighborSide = "before" | "after";

interface NeighborHit {
  neighbor: AudioClip;
  side: NeighborSide;
}

/** Same-track only: is the pointer, at drop, actually resting on top of one
 *  of the dragged clip's immediate neighbors? Driven by where the pointer
 *  landed (hitClipId, from resolveClipAt against the raw drop coordinates),
 *  not by whether the clip's own computed span happens to reach into a
 *  neighbor — dropping a long clip in genuinely empty space shouldn't count
 *  as a swap just because the clip itself is long enough to overlap
 *  something once placed there (resolveNonOverlappingStart's block/clamp
 *  handles that case instead). A hit on a non-adjacent clip also falls
 *  through to block/clamp — swap only makes sense for a genuine neighbor. */
function findSameTrackNeighborAtPointer(
  clip: AudioClip,
  trackClips: AudioClip[],
  hitClipId: string | null
): NeighborHit | null {
  if (!hitClipId || hitClipId === clip.id) return null;
  const sorted = [...trackClips].sort((a, b) => a.startSample - b.startSample);
  const idx = sorted.findIndex((c) => c.id === clip.id);
  if (idx === -1) return null;
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
  if (prev && prev.id === hitClipId) return { neighbor: prev, side: "before" };
  if (next && next.id === hitClipId) return { neighbor: next, side: "after" };
  return null;
}

/** Swaps clip/neighbor, keeping them contiguous. Only touches these two. */
function computeSwapPositions(
  clip: AudioClip,
  neighbor: AudioClip,
  side: NeighborSide
): { clipStart: number; neighborStart: number } {
  if (side === "before") {
    const clipStart = neighbor.startSample;
    return { clipStart, neighborStart: clipStart + clip.durationSamples };
  }
  const neighborStart = clip.startSample;
  return { clipStart: neighborStart + neighbor.durationSamples, neighborStart };
}

/**
 * Enables clip dragging with cross-track support. Drops are blocked from
 * overlapping a neighbor (resolveNonOverlappingStart, utils/clipGeometry.ts —
 * shared with the upload-at-playhead path in useTimelineTracks.ts), except a
 * same-track drop where the pointer lands directly on one immediate
 * neighbor, which offers a swap via ClipSwapConfirmPopover instead
 * (findSameTrackNeighborAtPointer).
 *
 * The library's own ClipInteractionProvider is a turnkey drag layer, but it
 * unconditionally applies a horizontal-axis restriction, and its onDragEnd
 * delegates to engine.moveClip() — which only lets a clip slide within its
 * current gap and has no cross-track primitive at all. Whether a clip
 * renders as draggable is gated by an internal context flag that only
 * ClipInteractionProvider can set (it isn't exported), so we keep it mounted
 * for that side effect and nest our own DragDropProvider inside it.
 * Draggables always bind to the nearest DragDropProvider ancestor, so ours
 * takes over the actual interaction — ClipInteractionProvider's own outer
 * one ends up with nothing registered.
 *
 * Every accepted clip *move/swap* (same-track or cross-track) is applied by
 * reassigning the tracks array directly via onTracksChange — the same
 * "external update" path used everywhere else in this app (import, remove,
 * add track). Boundary trims and cancelled drags are untouched and still
 * delegate to the library.
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
  const { tracks, samplesPerPixel, timeScaleHeight, playoutRef, isDraggingRef, onTracksChange } =
    usePlaylistData();
  const { setSelectedTrackId, scrollContainerRef, stop } = usePlaylistControls();
  const { isPlaying } = usePlaybackAnimation();
  const sensors = useDragSensors();

  const [pendingSwap, setPendingSwap] = useState<PendingSwap | null>(null);

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

  const updateEngineOutputLive = useProjectStore((s) => s.updateEngineOutputLive);
  const beginLiveDrag = useProjectStore((s) => s.beginLiveDrag);
  const cancelLiveDrag = useProjectStore((s) => s.cancelLiveDrag);

  // useClipDragHandlers' own onDragMove calls this repeatedly (once per
  // pointer-move frame) while a boundary (trim) drag is in progress, to
  // drive the live preview — it never represents a settled state (the
  // *actual* trim only applies at drag-end, via engine.trimClip() +
  // commitTransaction(), which mirrors back through the unwrapped
  // onTracksChange from usePlaylistData() below, a completely separate call
  // path). Routing these frames through updateEngineOutputLive (present
  // updates, no undo-history push) instead of the real onTracksChange stops
  // a single trim gesture from becoming dozens of separately-undoable steps
  // — confirmed via direct instrumentation that a short trim drag fires this
  // ten-plus times. See projectStore.ts's own doc comment on
  // updateEngineOutputLive.
  const liveOnTracksChange = useCallback(
    (raw: ClipTrack[]) => {
      updateEngineOutputLive(raw, dehydrate(raw));
    },
    [updateEngineOutputLive]
  );

  const {
    onDragStart: libraryOnDragStart,
    onDragMove,
    onDragEnd: libraryOnDragEnd,
  } = useClipDragHandlers({
    tracks,
    onTracksChange: liveOnTracksChange,
    samplesPerPixel,
    engineRef: playoutRef,
    isDraggingRef,
  });

  const onDragStart = useCallback(
    (event: DragStartEventArg) => {
      dragStartScrollLeftRef.current = scrollContainerRef.current?.scrollLeft ?? 0;
      const data = event.operation?.source?.data as ClipSourceData | undefined;
      // Boundary (trim) drags are about to start feeding live-preview frames
      // through liveOnTracksChange/updateEngineOutputLive, which would
      // otherwise overwrite `present` before the drag settles — capture the
      // true pre-drag baseline now, once, for commitEngineOutput to use as
      // the undo entry's `before`. See projectStore.ts's dragBaseline doc
      // comment. Gated on data?.boundary so a plain clip move (which never
      // touches updateEngineOutputLive at all) never sets this.
      if (data?.boundary) {
        beginLiveDrag();
      }
      if (data && tracks[data.trackIndex]) {
        setSelectedTrackId(tracks[data.trackIndex].id);
      }
      (libraryOnDragStart as LibraryDragHandler)(event as never);
    },
    [libraryOnDragStart, tracks, setSelectedTrackId, scrollContainerRef, beginLiveDrag]
  );

  const onDragEnd = useCallback(
    (event: DragEndEventArg) => {
      const data = event.operation?.source?.data as ClipSourceData | undefined;

      // Trims and cancelled drags are entirely the library's concern. A move
      // landing while a play() call is mid-await on engine.init() is treated
      // the same way — see the playPendingRef doc comment on this component.
      if (event.canceled || !data || data.boundary || playPendingRef.current) {
        // A cancelled boundary drag reverts via liveOnTracksChange (never a
        // real commitEngineOutput call), so the baseline beginLiveDrag()
        // captured above would otherwise never get cleared and could
        // corrupt the *next* drag's undo entry.
        if (data?.boundary && event.canceled) {
          cancelLiveDrag();
        }
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

      // What clip (if any) the pointer is actually resting on at drop —
      // drives the swap trigger below, not the dragged clip's own computed
      // span (a long clip dropped in genuine empty space shouldn't offer a
      // swap just because it's long enough to reach into a neighbor once
      // placed there).
      const scrollContainer = scrollContainerRef.current;
      const pointerHit = scrollContainer
        ? resolveClipAt(
            event.operation.position.current.x,
            event.operation.position.current.y,
            scrollContainer,
            tracks,
            samplesPerPixel,
            timeScaleHeight
          )
        : null;
      const hitClipId =
        pointerHit ? (tracks[pointerHit.trackIndex]?.clips[pointerHit.clipIndex]?.id ?? null) : null;

      // Same-track only: dropping directly on a single immediate neighbor
      // offers a swap instead of blocking. No commit yet — just show the
      // popover.
      if (sourceTrackIndex === targetTrackIndex) {
        const overlap = findSameTrackNeighborAtPointer(clip, sourceTrack.clips, hitClipId);
        if (overlap) {
          playoutRef.current?.abortTransaction();
          isDraggingRef.current = false;
          setPendingSwap({
            trackId: sourceTrack.id,
            clipId: clip.id,
            neighborId: overlap.neighbor.id,
            side: overlap.side,
            clipName: clip.name,
            neighborName: overlap.neighbor.name,
            anchor: {
              x: event.operation.position.current.x,
              y: event.operation.position.current.y,
            },
          });
          return;
        }
      }

      const otherClips = targetTrack.clips.filter((c) => c.id !== clip.id);
      const newStartSample = resolveNonOverlappingStart(
        proposedStartSample,
        clip.durationSamples,
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
      // playing" section for the full trace. `stop()` alone used to be enough
      // (it's synchronous, no `await`), on the assumption that it'd batch
      // into the same commit as the `onTracksChange` call below — true when
      // both `isPlaying` and `tracks` lived in plain React state under the
      // same root. Since Phase 2, `tracks` flows through a Zustand store
      // instead, and that external-store-triggered re-render does not
      // reliably land in the same commit as `stop()`'s own `setIsPlaying`
      // (confirmed by direct instrumentation of the vendored provider: the
      // rebuild effect observed `wasPlaying: true` even though `stop()` had
      // already run earlier in the same synchronous callback) — so the
      // library's buggy pendingResumeRef/resumePlayback path armed anyway,
      // corrupting the engine exactly as before. `flushSync` forces `stop()`'s
      // render (and the `isPlayingRef.current = isPlaying` line the provider
      // syncs during render) to fully commit before `onTracksChange` runs,
      // making the ordering correct regardless of whether the two updates
      // would otherwise batch.
      //
      // Kept local here rather than centralized into projectStore.ts's
      // `commit` (see its `stopIfPlaying`/`registerStopIfPlaying` doc
      // comment, which now covers duplicate/delete/add-remove-track/import/
      // undo/redo): `onTracksChange` below reaches `commitEngineOutput`, not
      // `commit` — and `commitEngineOutput` also carries trim/split's
      // engine-driven mirror-back, which must NOT stop playback (no rebuild
      // happens for those). Only this call site knows it's about to
      // hand-apply a move rather than mirror an engine transaction, so only
      // it can guard correctly.
      if (isPlaying) {
        flushSync(() => stop());
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
      timeScaleHeight,
      playoutRef,
      isDraggingRef,
      playPendingRef,
      scrollContainerRef,
      isPlaying,
      stop,
      libraryOnDragEnd,
      cancelLiveDrag,
    ]
  );

  // Re-looks-up clip/neighbor by id and re-checks adjacency rather than
  // trusting what was captured at drag-end — some other commit (another
  // drag, duplicate/delete, undo/redo) may have landed while the popover
  // was open. A stale pending swap just no-ops.
  //
  // Reads `pendingSwap` directly from the closure rather than via
  // setPendingSwap's updater-callback form: this is only ever invoked from
  // a button click (never a rapid-fire event needing the updater form to
  // dodge a stale closure), and the side effects below (flushSync, which
  // itself must not run during another component's render, and
  // onTracksChange, which flows into a Zustand set()) can't safely run
  // *inside* a setState updater — same class of bug useFadeDragHandlers.ts
  // already found and fixed once (see its own doc comment on
  // dragMetaRef.current.previewDurationSamples).
  const confirmPendingSwap = useCallback(() => {
    const pending = pendingSwap;
    setPendingSwap(null);
    if (!pending) return;

    const track = tracks.find((t) => t.id === pending.trackId);
    const clip = track?.clips.find((c) => c.id === pending.clipId);
    const neighbor = track?.clips.find((c) => c.id === pending.neighborId);
    if (!track || !clip || !neighbor) return;

    const sorted = [...track.clips].sort((a, b) => a.startSample - b.startSample);
    const idx = sorted.findIndex((c) => c.id === clip.id);
    const stillAdjacent =
      (pending.side === "before" && idx > 0 && sorted[idx - 1].id === neighbor.id) ||
      (pending.side === "after" && idx < sorted.length - 1 && sorted[idx + 1].id === neighbor.id);
    if (!stillAdjacent) return;

    const { clipStart, neighborStart } = computeSwapPositions(clip, neighbor, pending.side);
    const newTracks: ClipTrack[] = tracks.map((t) =>
      t.id !== track.id
        ? t
        : {
            ...t,
            clips: t.clips.map((c) =>
              c.id === clip.id
                ? { ...c, startSample: clipStart }
                : c.id === neighbor.id
                  ? { ...c, startSample: neighborStart }
                  : c
            ),
          }
    );

    if (isPlaying) {
      flushSync(() => stop());
    }
    onTracksChange?.(newTracks);
  }, [pendingSwap, tracks, onTracksChange, isPlaying, stop]);

  const declinePendingSwap = useCallback(() => setPendingSwap(null), []);

  return (
    <>
      <DragDropProvider
        sensors={sensors}
        onDragStart={onDragStart}
        onDragMove={onDragMove as unknown as DragDropProviderProps["onDragMove"]}
        onDragEnd={onDragEnd}
        plugins={noDropAnimationPlugins}
      >
        {children}
      </DragDropProvider>
      {pendingSwap && (
        <ClipSwapConfirmPopover
          anchor={pendingSwap.anchor}
          clipName={pendingSwap.clipName}
          neighborName={pendingSwap.neighborName}
          onConfirm={confirmPendingSwap}
          onDecline={declinePendingSwap}
        />
      )}
    </>
  );
}
