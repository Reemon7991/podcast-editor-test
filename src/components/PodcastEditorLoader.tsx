"use client";

import dynamic from "next/dynamic";

// Tone.js (pulled in via WaveformPlaylistProvider) touches browser globals
// at module-evaluation time, so this subtree cannot be server-rendered.
const PodcastEditor = dynamic(
  () => import("./PodcastEditor").then((mod) => mod.PodcastEditor),
  {
    ssr: false,
    loading: () => (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Loading editor…
      </p>
    ),
  }
);

export function PodcastEditorLoader() {
  return <PodcastEditor />;
}
