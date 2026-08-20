import type { SupabaseClient } from "@supabase/supabase-js";
import { randomToken } from "../util";
import type {
  AnalysisPlayers,
  InvitePreview,
  LibraryEntry,
  MetadataStore,
  Participant,
  ParticipantInput,
  ParticipantInvite,
  ShareLink,
  UserResult,
  Video,
  VideoSegment,
} from "./types";

/** DB row shape (snake_case) for the `videos` table. */
interface Row {
  id: string;
  owner_id: string | null;
  title: string;
  key: string;
  upload_id: string | null;
  content_type: string;
  size_bytes: number;
  part_size_bytes: number;
  duration_s: number | null;
  status: Video["status"];
  visibility: Video["visibility"];
  recorded_at: string | null;
  created_at: string;
  deleted_at: string | null;
  analysis_status: Video["analysisStatus"] | null;
  analysis_task_id: string | null;
  analysis_windows: Video["analysisWindows"];
  analysis_error: string | null;
  analyzed_at: string | null;
  analysis_players: AnalysisPlayers | null;
  has_analysis_proxy: boolean | null;
}

function toVideo(r: Row): Video {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    key: r.key,
    uploadId: r.upload_id,
    contentType: r.content_type,
    sizeBytes: r.size_bytes,
    partSizeBytes: r.part_size_bytes,
    durationS: r.duration_s,
    status: r.status,
    visibility: r.visibility,
    recordedAt: r.recorded_at,
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    analysisStatus: r.analysis_status ?? "none",
    analysisTaskId: r.analysis_task_id,
    analysisWindows: r.analysis_windows ?? null,
    analysisError: r.analysis_error,
    analyzedAt: r.analyzed_at,
    analysisPlayers: r.analysis_players ?? null,
    hasAnalysisProxy: r.has_analysis_proxy ?? false,
  };
}

/** Only the columns present in `patch`, mapped to snake_case, for partial updates. */
function toRow(patch: Partial<Video>): Partial<Row> {
  const row: Partial<Row> = {};
  if (patch.ownerId !== undefined) row.owner_id = patch.ownerId;
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.key !== undefined) row.key = patch.key;
  if (patch.uploadId !== undefined) row.upload_id = patch.uploadId;
  if (patch.contentType !== undefined) row.content_type = patch.contentType;
  if (patch.sizeBytes !== undefined) row.size_bytes = patch.sizeBytes;
  if (patch.partSizeBytes !== undefined) row.part_size_bytes = patch.partSizeBytes;
  if (patch.durationS !== undefined) row.duration_s = patch.durationS;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.visibility !== undefined) row.visibility = patch.visibility;
  if (patch.recordedAt !== undefined) row.recorded_at = patch.recordedAt;
  if (patch.deletedAt !== undefined) row.deleted_at = patch.deletedAt;
  if (patch.analysisStatus !== undefined) row.analysis_status = patch.analysisStatus;
  if (patch.analysisTaskId !== undefined) row.analysis_task_id = patch.analysisTaskId;
  if (patch.analysisWindows !== undefined) row.analysis_windows = patch.analysisWindows;
  if (patch.analysisError !== undefined) row.analysis_error = patch.analysisError;
  if (patch.analyzedAt !== undefined) row.analyzed_at = patch.analyzedAt;
  if (patch.analysisPlayers !== undefined) row.analysis_players = patch.analysisPlayers;
  if (patch.hasAnalysisProxy !== undefined) row.has_analysis_proxy = patch.hasAnalysisProxy;
  return row;
}

/**
 * Postgres-backed metadata store. Uses a request-scoped Supabase client, so all
 * reads/writes run under the signed-in user's RLS policies. Share-link resolution
 * goes through security-definer RPCs (see migration 0002) rather than table reads.
 */
export class SupabaseMetadataStore implements MetadataStore {
  constructor(
    private supabase: SupabaseClient,
    /** The caller — needed for "did *I* share this", which RLS alone can't express. */
    private userId: string | null = null,
    /**
     * True when the client holds the service-role key and there is no signed-in
     * user — the cron sweep. RLS is bypassed, but so is `auth.uid()`, which the
     * edit-rights RPCs depend on; see `replaceSegments`.
     */
    private serviceRole = false,
  ) {}

  async create(video: Video): Promise<Video> {
    // No `.select()` here: returning the inserted row would run the videos SELECT
    // policy (can_view_video), whose STABLE re-query of `videos` can't see the
    // just-inserted row in its own snapshot → 0 rows → error. We already have the
    // full row, so insert (INSERT policy only) and return it.
    const { error } = await this.supabase.from("videos").insert({ id: video.id, ...toRow(video) });
    if (error) throw new Error(`create video failed: ${error.message}`);
    return video;
  }

  async get(id: string): Promise<Video | null> {
    const { data, error } = await this.supabase.from("videos").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`get video failed: ${error.message}`);
    return data ? toVideo(data as Row) : null;
  }

  async list(): Promise<LibraryEntry[]> {
    // Videos in the caller's library, newest addition first. `!inner` drops rows
    // whose video is inaccessible (e.g. soft-deleted) under the videos RLS policy.
    const { data, error } = await this.supabase
      .from("library_items")
      .select("added_via, videos!inner(*)")
      .order("added_at", { ascending: false });
    if (error) throw new Error(`list library failed: ${error.message}`);

    const rows = data as unknown as Array<{ added_via: LibraryEntry["addedVia"]; videos: Row }>;
    const { linked, shared } = await this.shareStateFor(rows.map((r) => r.videos.id));

    return rows.map((r) => ({
      ...toVideo(r.videos),
      addedVia: r.added_via,
      hasActiveShareLink: linked.has(r.videos.id),
      sharedToFollowers: shared.has(r.videos.id),
    }));
  }

  /**
   * Bulk share state for a set of matches: which have a live link, and which the
   * caller posted to their followers. Two indexed lookups for the whole library
   * rather than a pair per card.
   */
  private async shareStateFor(
    ids: string[],
  ): Promise<{ linked: Set<string>; shared: Set<string> }> {
    if (!ids.length) return { linked: new Set(), shared: new Set() };

    const [links, shares] = await Promise.all([
      this.supabase
        .from("share_links")
        .select("video_id")
        .in("video_id", ids)
        .is("revoked_at", null)
        .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
      // RLS lets you read anyone's shares of a visible video, so scope to the
      // caller explicitly — "shared" on your own card means *you* posted it.
      this.userId
        ? this.supabase
            .from("match_shares")
            .select("video_id")
            .in("video_id", ids)
            .eq("user_id", this.userId)
        : { data: [] as Array<{ video_id: string }> },
    ]);

    const ids_ = (rows: unknown) =>
      new Set(((rows ?? []) as Array<{ video_id: string }>).map((r) => r.video_id));
    return { linked: ids_(links.data), shared: ids_(shares.data) };
  }

  async hasActiveShareLink(videoId: string): Promise<boolean> {
    const { linked } = await this.shareStateFor([videoId]);
    return linked.has(videoId);
  }

  async listByOwner(ownerId: string): Promise<Video[]> {
    const { data, error } = await this.supabase
      .from("videos")
      .select()
      .eq("owner_id", ownerId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`list by owner failed: ${error.message}`);
    return (data as Row[]).map(toVideo);
  }

  async listInFlightAnalyses(limit = 50): Promise<Video[]> {
    const { data, error } = await this.supabase
      .from("videos")
      .select()
      .eq("analysis_status", "processing")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`list in-flight analyses failed: ${error.message}`);
    return (data as Row[]).map(toVideo);
  }

  async update(id: string, patch: Partial<Video>): Promise<Video> {
    const { data, error } = await this.supabase
      .from("videos")
      .update(toRow(patch))
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`update video failed: ${error.message}`);
    return toVideo(data as Row);
  }

  async setTitle(id: string, title: string): Promise<Video> {
    const { data, error } = await this.supabase.rpc("update_video_title", {
      p_video_id: id,
      p_title: title,
    });
    if (error || !data) throw new Error(`rename failed: ${error?.message ?? "no data"}`);
    return toVideo(data as Row);
  }

  async softDelete(id: string): Promise<void> {
    const { error } = await this.supabase
      .from("videos")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id); // RLS enforces owner-only
    if (error) throw new Error(`soft-delete video failed: ${error.message}`);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.supabase.from("videos").delete().eq("id", id);
    if (error) throw new Error(`delete video failed: ${error.message}`);
  }

  async createShareLink(videoId: string, createdBy: string | null): Promise<ShareLink> {
    // Reuse this sharer's own live link so their URL stays stable. Scoped to
    // created_by on purpose: links are per-sharer and individually revocable, so
    // reusing someone else's would mean revoking yours killed theirs too.
    let q = this.supabase
      .from("share_links")
      .select("token")
      .eq("video_id", videoId)
      .is("revoked_at", null);
    q = createdBy ? q.eq("created_by", createdBy) : q.is("created_by", null);
    const { data: existing } = await q.limit(1).maybeSingle();
    if (existing?.token) return { token: existing.token as string };

    const token = randomToken();
    const { error } = await this.supabase
      .from("share_links")
      .insert({ token, video_id: videoId, created_by: createdBy });
    if (error) throw new Error(`create share link failed: ${error.message}`);
    return { token };
  }

  async getByShareToken(token: string): Promise<Video | null> {
    const { data, error } = await this.supabase.rpc("get_shared_video", { p_token: token });
    if (error || !data) return null;
    return toVideo(data as Row);
  }

  async addToLibrary(token: string): Promise<Video | null> {
    const { data, error } = await this.supabase.rpc("add_shared_video", { p_token: token });
    if (error || !data) return null;
    return toVideo(data as Row);
  }

  async removeFromLibrary(videoId: string, userId: string | null): Promise<void> {
    let q = this.supabase.from("library_items").delete().eq("video_id", videoId);
    if (userId) q = q.eq("user_id", userId); // RLS also scopes to the caller
    const { error } = await q;
    if (error) throw new Error(`remove from library failed: ${error.message}`);
  }

  async getParticipants(videoId: string): Promise<Participant[]> {
    const { data, error } = await this.supabase
      .from("video_participants")
      .select("id, user_id, display_name, email")
      .eq("video_id", videoId)
      .order("created_at");
    if (error) throw new Error(`get participants failed: ${error.message}`);
    return (data as Array<{ id: string; user_id: string | null; display_name: string; email: string | null }>).map(
      (r) => ({ id: r.id, userId: r.user_id, displayName: r.display_name, email: r.email }),
    );
  }

  async setParticipants(videoId: string, participants: ParticipantInput[]): Promise<Participant[]> {
    // One definer RPC that checks edit rights once, then replaces the list — so a
    // participant editor doesn't lose permission mid delete-then-insert. `added_by`
    // is taken from auth.uid() inside the RPC.
    const { error } = await this.supabase.rpc("set_participants", {
      p_video_id: videoId,
      p_participants: participants.map((p) => ({
        userId: p.userId,
        displayName: p.displayName,
        email: p.email,
      })),
    });
    if (error) throw new Error(`set participants failed: ${error.message}`);
    return this.getParticipants(videoId);
  }

  async listInvites(videoId: string): Promise<ParticipantInvite[]> {
    // Definer RPC: it checks edit rights, and mints a token for any pending
    // invite that predates 0015 so old invites become linkable rather than
    // stranded. The tokens are not readable through a plain select — the column
    // is withheld by grant.
    const { data, error } = await this.supabase.rpc("participant_invites", {
      p_video_id: videoId,
    });
    if (error) throw new Error(`list invites failed: ${error.message}`);
    return (
      data as Array<{
        id: string;
        display_name: string;
        email: string;
        invite_token: string | null;
        claimed: boolean;
      }>
    ).map((r) => ({
      id: r.id,
      displayName: r.display_name,
      email: r.email,
      token: r.invite_token,
      claimed: r.claimed,
    }));
  }

  async invitePreview(token: string): Promise<InvitePreview | null> {
    const { data, error } = await this.supabase.rpc("invite_preview", { p_token: token });
    const row = (
      data as Array<{
        video_id: string;
        match_title: string;
        invited_name: string;
        invited_email: string | null;
        inviter_name: string | null;
        claimed: boolean;
      }> | null
    )?.[0];
    if (error || !row) return null;
    return {
      videoId: row.video_id,
      matchTitle: row.match_title,
      invitedName: row.invited_name,
      invitedEmail: row.invited_email,
      inviterName: row.inviter_name,
      claimed: row.claimed,
    };
  }

  async claimInvite(token: string): Promise<string | null> {
    const { data, error } = await this.supabase.rpc("claim_invite", { p_token: token });
    if (error || !data) return null;
    return data as string;
  }

  async searchUsers(query: string): Promise<UserResult[]> {
    // Through the `search_users` RPC rather than a select on `profiles`, so the
    // result is filtered by the symmetric `is_blocked()` — see 0016. A block has
    // to hide people in both directions, and only the database can see the half
    // of user_blocks where the caller is the blocked party.
    const { data, error } = await this.supabase.rpc("search_users", {
      p_query: query,
      p_limit: 10,
    });
    if (error) throw new Error(`search users failed: ${error.message}`);
    return (data as Array<{ id: string; display_name: string }>).map((r) => ({
      id: r.id,
      displayName: r.display_name,
    }));
  }

  async getSegments(videoId: string, kind = "rally"): Promise<VideoSegment[]> {
    const { data, error } = await this.supabase
      .from("video_segments")
      .select("id, kind, idx, start_s, end_s, metadata")
      .eq("video_id", videoId)
      .eq("kind", kind)
      .order("idx");
    if (error) throw new Error(`get segments failed: ${error.message}`);
    return (
      data as Array<{
        id: string;
        kind: string;
        idx: number;
        start_s: number | null;
        end_s: number | null;
        metadata: Record<string, unknown> | null;
      }>
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      idx: r.idx,
      startS: r.start_s,
      endS: r.end_s,
      metadata: r.metadata ?? {},
    }));
  }

  async replaceSegments(
    videoId: string,
    kind: string,
    segments: Omit<VideoSegment, "id">[],
  ): Promise<void> {
    // The RPC gates on can_edit_video(), which reads auth.uid(). Under the
    // service role there is no auth.uid(), so the RPC would refuse — write the
    // rows directly instead, which the service role is entitled to do. The
    // authorization that matters already happened: only the owner can start a
    // run, and the cron only ever advances runs that were already started.
    if (this.serviceRole) {
      const { error: delError } = await this.supabase
        .from("video_segments")
        .delete()
        .eq("video_id", videoId)
        .eq("kind", kind);
      if (delError) throw new Error(`replace segments (delete) failed: ${delError.message}`);
      if (!segments.length) return;
      const { error: insError } = await this.supabase.from("video_segments").insert(
        segments.map((s) => ({
          video_id: videoId,
          kind,
          idx: s.idx,
          start_s: s.startS,
          end_s: s.endS,
          metadata: s.metadata,
        })),
      );
      if (insError) throw new Error(`replace segments (insert) failed: ${insError.message}`);
      return;
    }

    // Definer RPC checks edit rights once, then delete + bulk insert (see 0009).
    const { error } = await this.supabase.rpc("replace_video_segments", {
      p_video_id: videoId,
      p_kind: kind,
      p_segments: segments.map((s) => ({
        idx: s.idx,
        startS: s.startS,
        endS: s.endS,
        metadata: s.metadata,
      })),
    });
    if (error) throw new Error(`replace segments failed: ${error.message}`);
  }
}
