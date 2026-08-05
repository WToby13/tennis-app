import { socialForRequest, storeForRequest } from "@/lib/request";
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

  // Social state for the watch page (like/follow/share).
  const { social } = await socialForRequest();
  const like = await social.likeState(video.id);
  const sharedToFollowers = await social.isSharedToFollowers(video.id);
  const summary = video.ownerId ? await social.profileSummary(video.ownerId) : null;

  return json({
    video,
    playbackUrl,
    thumbnailUrl,
    isOwner,
    canEdit,
    inLibrary,
    canAdd: !inLibrary,
    participants,
    likeCount: like.count,
    likedByMe: like.likedByMe,
    sharedToFollowers,
    author: summary ? { id: summary.id, displayName: summary.displayName } : null,
    isFollowingOwner: summary?.isFollowing ?? false,
  });
}

/**
 * Edit a match. Title is editable by the owner or any participant; visibility
 * (private/public) is owner-only.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const body = await req.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const visibility =
    body?.visibility === "private" || body?.visibility === "public" ? body.visibility : null;
  if (!title && !visibility) return badRequest("nothing to update");

  const participants = await store.getParticipants(id).catch(() => []);
  const isOwner = !userId || video.ownerId === userId;
  const canEdit = isOwner || participants.some((p) => p.userId === userId);
  if (!canEdit) return notFound("Video not found");

  let updated = video;
  if (title) updated = await store.setTitle(id, title); // RPC enforces edit rights
  if (visibility) {
    if (!isOwner) return notFound("Video not found");
    updated = await store.update(id, { visibility }); // owner-only via videos RLS
  }
  return json({ video: updated });
}
