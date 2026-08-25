import { track } from "@/lib/analytics/server";
import { storeForRequest } from "@/lib/request";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Mint (or reuse) a revocable share link. Anyone who can access the video
 * (owner, in-library, or public) can share it onward — each sharer gets their
 * own revocable link. `store.get` returning the video is exactly that access
 * check under RLS.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const { token } = await store.createShareLink(id, userId);

  // The loop's input (docs/GTM.md §2). Minting the link is the moment of
  // intent — whether it then gets pasted into WhatsApp is something we find
  // out from `share_link_opened`, not from here.
  track("match_shared", { userId, videoId: id, props: { channel: "link" } });

  return json({ token, path: `/watch/${id}?s=${token}` });
}
