import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Discard an incomplete upload. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();
  const video = await store.get(id);
  if (!video || !video.uploadId) return notFound("Upload not found");

  await storage().abortMultipart(video.key, video.uploadId);
  await store.update(id, { status: "failed", uploadId: null });
  return json({ ok: true });
}
