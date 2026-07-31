"use client";

import dynamic from "next/dynamic";
import { LoadingState } from "./ui/LoadingState";

// Tone.js (pulled in via WaveformPlaylistProvider) touches browser globals
// at module-evaluation time, so this subtree cannot be server-rendered.
const PodcastEditor = dynamic(
  () => import("./PodcastEditor").then((mod) => mod.PodcastEditor),
  {
    ssr: false,
    loading: () => <LoadingState message="Loading editor…" />,
  }
);

export function PodcastEditorLoader() {
  return <PodcastEditor />;
}
