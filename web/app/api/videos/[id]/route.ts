import { deriveMatchStatus } from "@/lib/matchStatus";
import { socialForRequest, storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { badRequest, json, notFound, sanitizePlayers } from "@/lib/util";

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

  // Social state for the watch page (like/follow/share).
  const { social } = await socialForRequest();

  // Everything below depends only on `video`, so it all goes out at once — this
  // route used to serialize seven independent round trips.
  const [
    participants,
    segments,
    playbackUrl,
    thumbnailUrl,
    like,
    sharedToFollowers,
    summary,
    hasActiveShareLink,
  ] = await Promise.all([
    store.getParticipants(video.id).catch(() => []),
    store.getSegments(video.id).catch(() => []),
    video.status === "ready" ? storage().getPlaybackUrl(video.id, video.key) : null,
    storage()
      .getThumbnailUrl(video.id)
      .catch(() => null),
    social.likeState(video.id),
    social.isSharedToFollowers(video.id),
    video.ownerId ? social.profileSummary(video.ownerId) : null,
    store.hasActiveShareLink(video.id).catch(() => false),
  ]);

  const isOwner = Boolean(userId && video.ownerId && video.ownerId === userId);
  const isParticipant = Boolean(userId && participants.some((p) => p.userId === userId));
  // Owner or participant may edit; local no-auth mode can too.
  const canEdit = isOwner || isParticipant || !userId;

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
    analysisStatus: video.analysisStatus,
    analysisError: video.analysisError,
    analysisPlayers: video.analysisPlayers,
    // The derived upload/analysis/share model — see lib/matchStatus.ts. Additive:
    // the individual fields above stay for existing clients.
    matchStatus: deriveMatchStatus(video, {
      visibility: video.visibility,
      hasActiveShareLink,
      sharedToFollowers,
    }),
    segments,
    // Owner-only trigger (local no-auth mode has no owner, so it's allowed there
    // too — matches the analyze route's own authorization).
    canAnalyze: !userId || isOwner,
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
  const hasPlayers = body?.players !== undefined && body?.players !== null;
  if (!title && !visibility && !hasPlayers) return badRequest("nothing to update");

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
  if (hasPlayers) {
    if (!isOwner) return notFound("Video not found"); // player names are the owner's
    updated = await store.update(id, { analysisPlayers: sanitizePlayers(body.players) });
  }
  return json({ video: updated });
}
