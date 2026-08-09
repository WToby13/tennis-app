import { Library } from "./Library";
import type { MatchVideo } from "@/lib/matchFormat";
import { loadLibrary, loadMe } from "@/lib/library";

/**
 * The library — profile, uploading and your matches on one page.
 *
 * Rendered on the server so the first paint already has the matches in it. The
 * old version was a client component that fetched on mount, so every visit went
 * HTML → JS → auth → fetch → content before anything appeared; that chain is
 * what made this page feel slow.
 *
 * Replaces the old /matches + /profile + /upload trio; those routes redirect
 * here. Profile editing is a modal (`?edit=profile` opens it, which is where the
 * OAuth callback sends first-time users to set their playing hand).
 */
export default async function MatchesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  const [{ edit }, videos, me] = await Promise.all([
    searchParams,
    loadLibrary(),
    loadMe(),
  ]);

  return (
    <Library
      initialVideos={videos as unknown as MatchVideo[]}
      profile={me.profile}
      account={me.account}
      openEditor={edit === "profile"}
    />
  );
}
