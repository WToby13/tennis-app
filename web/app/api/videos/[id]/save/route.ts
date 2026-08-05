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

  const { social } = await socialForRequest();
  await social.saveToLibrary(id);
  return json({ saved: true });
}
