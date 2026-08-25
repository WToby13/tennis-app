import { track } from "@/lib/analytics/server";
import { socialForRequest, storeForRequest } from "@/lib/request";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** "Add to profile": save a viewable match to my library. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();
  // Only save something I can actually see.
  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const { social, userId } = await socialForRequest();
  await social.saveToLibrary(id);

  // The same act as `/add`, reached from the feed or a match someone can
  // already see rather than through a share token. Distinguished by `via` so
  // share conversion stays honest about which route it came down.
  track("library_add", { userId, videoId: id, props: { via: "save" } });

  return json({ saved: true });
}
