import { storeForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Remove a video from the caller's own library. This does NOT delete the video
 * (that's owner-only, via DELETE /api/videos/[id]) — it just drops the caller's
 * library membership.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();
  await store.removeFromLibrary(id, userId);
  return json({ ok: true });
}
