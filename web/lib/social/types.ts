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
  /** Whether the match is already in the viewer's library ("add to profile" state). */
  inLibrary: boolean;
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
  /** Whether the caller has blocked this user — drives the profile's block/unblock control. */
  isBlocked: boolean;
}

/** What a report says was wrong. Mirrors the `reason` check constraint in SQL. */
export type ReportReason = "abuse" | "sexual" | "violence" | "spam" | "other";

/** A flag raised against a match or a comment. */
export interface ReportInput {
  targetKind: "match" | "comment";
  targetId: string;
  /** The account responsible, so a report stays actionable if the content is deleted. */
  reportedUserId: string | null;
  /** Title or comment body as it read when reported — kept because the content may not survive. */
  contentSnapshot: string | null;
  reason: ReportReason;
  details: string | null;
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

  /** Add a viewable match to my library ("add to profile"). */
  saveToLibrary(videoId: string): Promise<void>;

  // --- moderation ------------------------------------------------------------
  // App Store Review Guideline 1.2: an app with user-generated content must let
  // people report it and block whoever posted it.

  /** Stop seeing this user's matches and comments, and them mine. Also unfollows both ways. */
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  /** Whether the caller has blocked this user (one direction — the control's state). */
  hasBlocked(userId: string): Promise<boolean>;
  /** Everyone the caller has blocked, for the "Blocked accounts" list. */
  listBlocked(): Promise<ProfileSummary[]>;

  /** File a report against a match or a comment. */
  report(input: ReportInput): Promise<void>;
}
