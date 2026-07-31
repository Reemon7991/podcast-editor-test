"use client";

import { usePlaylistControls, usePlaylistData } from "@waveform-playlist/browser";
import { Button } from "../ui/Button";

/**
 * Custom icon-only zoom buttons. The vendor's own ZoomInButton/ZoomOutButton
 * hardcode literal "Zoom In"/"Zoom Out" text children with no icon/children
 * override (confirmed by reading @waveform-playlist/browser's dist source),
 * so they can't be restyled into icon-only buttons as-is — this mirrors
 * PlayButton.tsx's existing pattern of wrapping usePlaylistControls()/
 * usePlaylistData() directly instead of the vendor's own button component.
 */
export function ZoomControls() {
  const { zoomIn, zoomOut } = usePlaylistControls();
  const { canZoomIn, canZoomOut } = usePlaylistData();

  return (
    <div className="flex items-center gap-1">
      <Button variant="icon" onClick={zoomOut} disabled={!canZoomOut} title="Zoom Out" aria-label="Zoom Out">
        <ZoomOutIcon />
      </Button>
      <Button variant="icon" onClick={zoomIn} disabled={!canZoomIn} title="Zoom In" aria-label="Zoom In">
        <ZoomInIcon />
      </Button>
    </div>
  );
}

function ZoomOutIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}

function ZoomInIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
