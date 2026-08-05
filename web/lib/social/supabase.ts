import type { SupabaseClient } from "@supabase/supabase-js";
import type { Comment, FeedItem, LikeState, ProfileSummary, SocialStore } from "./types";

/** Row shape returned by the get_feed RPC (snake_case). */
interface FeedRow {
  id: string;
  owner_id: string | null;
  title: string;
  status: FeedItem["status"];
  duration_s: number | null;
  size_bytes: number;
  created_at: string;
  visibility: FeedItem["visibility"];
  author_name: string | null;
  shared_by: string | null;
  shared_by_name: string | null;
  participant_names: string | null;
  like_count: number;
  comment_count: number;
  liked_by_me: boolean;
  in_library: boolean;
}

/** Supabase-backed social store, scoped to the caller's session (RLS applies). */
export class SupabaseSocialStore implements SocialStore {
  constructor(
    private supabase: SupabaseClient,
    private userId: string | null,
  ) {}

  async getFeed(limit = 50): Promise<FeedItem[]> {
    const { data, error } = await this.supabase.rpc("get_feed", { p_limit: limit });
    if (error) throw new Error(`feed failed: ${error.message}`);
    return (data as FeedRow[]).map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      title: r.title,
      status: r.status,
      durationS: r.duration_s,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
      visibility: r.visibility,
      authorName: r.author_name,
      sharedBy: r.shared_by,
      sharedByName: r.shared_by_name,
      participantNames: r.participant_names,
      likeCount: Number(r.like_count),
      commentCount: Number(r.comment_count),
      likedByMe: r.liked_by_me,
      inLibrary: r.in_library,
    }));
  }

  async follow(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from("follows")
      .upsert({ follower_id: this.userId, followee_id: userId });
    if (error) throw new Error(`follow failed: ${error.message}`);
  }

  async unfollow(userId: string): Promise<void> {
    const { error } = await this.supabase
      .from("follows")
      .delete()
      .eq("follower_id", this.userId)
      .eq("followee_id", userId);
    if (error) throw new Error(`unfollow failed: ${error.message}`);
  }

  async isFollowing(userId: string): Promise<boolean> {
    if (!this.userId) return false;
    const { data } = await this.supabase
      .from("follows")
      .select("followee_id")
      .eq("follower_id", this.userId)
      .eq("followee_id", userId)
      .maybeSingle();
    return Boolean(data);
  }

  async profileSummary(userId: string): Promise<ProfileSummary | null> {
    const { data: profile } = await this.supabase
      .from("profiles")
      .select("id, display_name, first_name, last_name")
      .eq("id", userId)
      .maybeSingle();
    if (!profile) return null;
    const p = profile as { id: string; display_name: string | null; first_name: string | null; last_name: string | null };

    const followers = await this.count("follows", "followee_id", userId);
    const following = await this.count("follows", "follower_id", userId);

    return {
      id: p.id,
      displayName:
        p.display_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Ojo player",
      followers,
      following,
      isFollowing: await this.isFollowing(userId),
    };
  }

  private async count(table: string, column: string, value: string): Promise<number> {
    const { count } = await this.supabase
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(column, value);
    return count ?? 0;
  }

  async likeState(videoId: string): Promise<LikeState> {
    const count = await this.count("match_likes", "video_id", videoId);
    let likedByMe = false;
    if (this.userId) {
      const { data } = await this.supabase
        .from("match_likes")
        .select("user_id")
        .eq("video_id", videoId)
        .eq("user_id", this.userId)
        .maybeSingle();
      likedByMe = Boolean(data);
    }
    return { count, likedByMe };
  }

  async setLike(videoId: string, liked: boolean): Promise<void> {
    if (liked) {
      const { error } = await this.supabase
        .from("match_likes")
        .upsert({ video_id: videoId, user_id: this.userId });
      if (error) throw new Error(`like failed: ${error.message}`);
    } else {
      const { error } = await this.supabase
        .from("match_likes")
        .delete()
        .eq("video_id", videoId)
        .eq("user_id", this.userId);
      if (error) throw new Error(`unlike failed: ${error.message}`);
    }
  }

  async listComments(videoId: string): Promise<Comment[]> {
    const { data, error } = await this.supabase
      .from("match_comments")
      .select("id, video_id, author_id, body, created_at")
      .eq("video_id", videoId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`comments failed: ${error.message}`);
    const rows = data as Array<{ id: string; video_id: string; author_id: string; body: string; created_at: string }>;

    // Resolve author names in one query (no FK from comments → profiles to embed).
    const ids = [...new Set(rows.map((r) => r.author_id))];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data: profs } = await this.supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      for (const p of (profs ?? []) as Array<{ id: string; display_name: string | null }>) {
        if (p.display_name) names.set(p.id, p.display_name);
      }
    }
    return rows.map((r) => ({
      id: r.id,
      videoId: r.video_id,
      authorId: r.author_id,
      authorName: names.get(r.author_id) ?? "Ojo player",
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  async addComment(videoId: string, body: string): Promise<Comment> {
    const { data, error } = await this.supabase
      .from("match_comments")
      .insert({ video_id: videoId, author_id: this.userId, body })
      .select("id, video_id, author_id, body, created_at")
      .single();
    if (error) throw new Error(`comment failed: ${error.message}`);
    const r = data as { id: string; video_id: string; author_id: string; body: string; created_at: string };
    return { id: r.id, videoId: r.video_id, authorId: r.author_id, authorName: null, body: r.body, createdAt: r.created_at };
  }

  async deleteComment(commentId: string): Promise<void> {
    const { error } = await this.supabase.from("match_comments").delete().eq("id", commentId);
    if (error) throw new Error(`delete comment failed: ${error.message}`);
  }

  async isSharedToFollowers(videoId: string): Promise<boolean> {
    if (!this.userId) return false;
    const { data } = await this.supabase
      .from("match_shares")
      .select("video_id")
      .eq("video_id", videoId)
      .eq("user_id", this.userId)
      .maybeSingle();
    return Boolean(data);
  }

  async setSharedToFollowers(videoId: string, shared: boolean): Promise<void> {
    if (shared) {
      const { error } = await this.supabase
        .from("match_shares")
        .upsert({ video_id: videoId, user_id: this.userId });
      if (error) throw new Error(`share failed: ${error.message}`);
    } else {
      const { error } = await this.supabase
        .from("match_shares")
        .delete()
        .eq("video_id", videoId)
        .eq("user_id", this.userId);
      if (error) throw new Error(`unshare failed: ${error.message}`);
    }
  }

  async saveToLibrary(videoId: string): Promise<void> {
    const { error } = await this.supabase
      .from("library_items")
      .upsert({ video_id: videoId, user_id: this.userId, added_via: "share" });
    if (error) throw new Error(`save failed: ${error.message}`);
  }
}
