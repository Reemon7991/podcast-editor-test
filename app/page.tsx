import { PodcastEditorLoader } from "@/components/podcast-editor/PodcastEditorLoader";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center gap-8 bg-zinc-50 px-6 py-12 dark:bg-black">
      <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Podcast Editor — Evaluation
      </h1>
      <PodcastEditorLoader />
    </div>
  );
}
