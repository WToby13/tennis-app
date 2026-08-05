import type { VideoStatus, VideoVisibility } from "../metadata";

/** A home-feed item (a match, attributed to a sharer or your own). */
export interface FeedItem {
  id: string;
  ownerId: string | null;
  title: string;
  status: VideoStatus;
  durationS: number | null;
  sizeBytes: number;
  createdAt: string;
  visibility: VideoVisibility;
  authorName: string | null;
  /** Set when it reached your feed because someone you follow shared it. */
  sharedBy: string | null;
  sharedByName: string | null;
  participantNames: string | null;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  /** Attached by the API route (signed URL), not by the store. */
  thumbnailUrl?: string | null;
}

export interface Comment {
  id: string;
  videoId: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface LikeState {
  count: number;
  likedByMe: boolean;
}

export interface ProfileSummary {
  id: string;
  displayName: string;
  followers: number;
  following: number;
  isFollowing: boolean;
}

/**
 * The social graph + engagement store. Bound to the caller's Supabase session so
 * every read/write runs under their RLS. In local (no-auth) dev it degrades to a
 * single-user view (feed = your own library; follows/likes/comments inert).
 */
export interface SocialStore {
  getFeed(limit?: number): Promise<FeedItem[]>;

  follow(userId: string): Promise<void>;
  unfollow(userId: string): Promise<void>;
  isFollowing(userId: string): Promise<boolean>;
  profileSummary(userId: string): Promise<ProfileSummary | null>;

  likeState(videoId: string): Promise<LikeState>;
  setLike(videoId: string, liked: boolean): Promise<void>;

  listComments(videoId: string): Promise<Comment[]>;
  addComment(videoId: string, body: string): Promise<Comment>;
  deleteComment(commentId: string): Promise<void>;

  isSharedToFollowers(videoId: string): Promise<boolean>;
  setSharedToFollowers(videoId: string, shared: boolean): Promise<void>;
}
