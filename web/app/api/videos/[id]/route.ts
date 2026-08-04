import { storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Owner soft-delete: hide the video everywhere, then purge its bytes.
 * These are deliberately two steps — once clips can reference the original,
 * the purge becomes conditional on nothing else needing the bytes.
 * Non-owners don't delete here; they remove it from their own library instead
 * (see ./library).
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId && video.ownerId !== userId) return notFound("Video not found");

  await store.softDelete(video.id); // hide everywhere (RLS enforces owner-only)
  await storage().deleteVideoAssets(video.id, video.key); // separate byte purge

  return json({ ok: true });
}

/**
 * Video detail, including a playback URL once it's ready.
 *
 * Access: the caller sees it if they own it / have it in their library / it's
 * public (all via `store.get`), OR they arrived with a valid `?s=<token>` share
 * link. `canAdd` tells the UI to offer "Add to my account".
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const token = new URL(req.url).searchParams.get("s");
  let video = await store.get(id);
  const inLibrary = video !== null; // get() only returns it if the caller already has access

  if (!video && token) {
    const shared = await store.getByShareToken(token);
    if (shared && shared.id === id) video = shared;
  }
  if (!video) return notFound("Video not found");

  const participants = await store.getParticipants(video.id).catch(() => []);

  const isOwner = Boolean(userId && video.ownerId && video.ownerId === userId);
  const isParticipant = Boolean(userId && participants.some((p) => p.userId === userId));
  // Owner or participant may edit; local no-auth mode can too.
  const canEdit = isOwner || isParticipant || !userId;

  const playbackUrl =
    video.status === "ready" ? await storage().getPlaybackUrl(video.id, video.key) : null;

  const thumbnailUrl = await storage()
    .getThumbnailUrl(video.id)
    .catch(() => null);

  return json({
    video,
    playbackUrl,
    thumbnailUrl,
    isOwner,
    canEdit,
    inLibrary,
    canAdd: !inLibrary,
    participants,
  });
}

/** Rename a match. Allowed for the owner or any participant (editors). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const body = await req.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  if (!title) return badRequest("title is required");

  // The RPC enforces edit rights server-side; a clean 404 for non-editors.
  const participants = await store.getParticipants(id).catch(() => []);
  const canEdit =
    !userId || video.ownerId === userId || participants.some((p) => p.userId === userId);
  if (!canEdit) return notFound("Video not found");

  const updated = await store.setTitle(id, title);
  return json({ video: updated });
}
