import { metadata } from "../metadata";
import type { Comment, FeedItem, LikeState, ProfileSummary, SocialStore } from "./types";

/**
 * Single-user, no-auth dev store. The feed just mirrors the local library so the
 * layout is viewable in dev; the graph/engagement ops are inert (the real
 * behaviour lives in the Supabase store).
 */
export class LocalSocialStore implements SocialStore {
  async getFeed(): Promise<FeedItem[]> {
    const videos = await metadata().list();
    return videos.map((v) => ({
      id: v.id,
      ownerId: v.ownerId,
      title: v.title,
      status: v.status,
      durationS: v.durationS,
      sizeBytes: v.sizeBytes,
      createdAt: v.createdAt,
      visibility: v.visibility,
      authorName: "You",
      sharedBy: null,
      sharedByName: null,
      participantNames: null,
      likeCount: 0,
      commentCount: 0,
      likedByMe: false,
      inLibrary: true,
    }));
  }

  async follow(): Promise<void> {}
  async unfollow(): Promise<void> {}
  async isFollowing(): Promise<boolean> {
    return false;
  }
  async profileSummary(): Promise<ProfileSummary | null> {
    return null;
  }
  async likeState(): Promise<LikeState> {
    return { count: 0, likedByMe: false };
  }
  async setLike(): Promise<void> {}
  async listComments(): Promise<Comment[]> {
    return [];
  }
  async addComment(videoId: string, body: string): Promise<Comment> {
    return { id: "local", videoId, authorId: "local", authorName: "You", body, createdAt: new Date().toISOString() };
  }
  async deleteComment(): Promise<void> {}
  async isSharedToFollowers(): Promise<boolean> {
    return false;
  }
  async setSharedToFollowers(): Promise<void> {}
  async saveToLibrary(): Promise<void> {}

  // Moderation is inert here for the same reason the graph is: local mode has
  // exactly one user, so there is nobody to block and nobody to report to.
  async blockUser(): Promise<void> {}
  async unblockUser(): Promise<void> {}
  async hasBlocked(): Promise<boolean> {
    return false;
  }
  async listBlocked(): Promise<ProfileSummary[]> {
    return [];
  }
  async report(): Promise<void> {}
}
