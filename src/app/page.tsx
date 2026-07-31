import { PodcastEditorLoader } from "@/components/PodcastEditorLoader";

export default function Home() {
  return (
    // pb-24 reserves room for EditorShell.tsx's fixed bottom transport bar
    // (position: fixed to the viewport, not this page's own scroll) so it
    // never overlaps the last track row/footer.
    <div className="flex flex-1 flex-col items-stretch gap-4 bg-[var(--surface)] px-6 pt-6 pb-24">
      <PodcastEditorLoader />
    </div>
  );
}
