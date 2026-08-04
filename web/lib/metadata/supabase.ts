import type { SupabaseClient } from "@supabase/supabase-js";
import { randomToken } from "../util";
import type {
  LibraryEntry,
  MetadataStore,
  Participant,
  ParticipantInput,
  ShareLink,
  UserResult,
  Video,
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
  return row;
}

/**
 * Postgres-backed metadata store. Uses a request-scoped Supabase client, so all
 * reads/writes run under the signed-in user's RLS policies. Share-link resolution
 * goes through security-definer RPCs (see migration 0002) rather than table reads.
 */
export class SupabaseMetadataStore implements MetadataStore {
  constructor(private supabase: SupabaseClient) {}

  async create(video: Video): Promise<Video> {
    const { data, error } = await this.supabase
      .from("videos")
      .insert({ id: video.id, ...toRow(video) })
      .select()
      .single();
    if (error) throw new Error(`create video failed: ${error.message}`);
    return toVideo(data as Row);
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
    return (data as unknown as Array<{ added_via: LibraryEntry["addedVia"]; videos: Row }>).map(
      (r) => ({ ...toVideo(r.videos), addedVia: r.added_via }),
    );
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
    // Reuse an existing live link so the shareable URL stays stable.
    const { data: existing } = await this.supabase
      .from("share_links")
      .select("token")
      .eq("video_id", videoId)
      .is("revoked_at", null)
      .limit(1)
      .maybeSingle();
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

  async searchUsers(query: string): Promise<UserResult[]> {
    const like = `%${query.replace(/[%_]/g, "")}%`;
    const { data, error } = await this.supabase
      .from("profiles")
      .select("id, display_name, first_name, last_name")
      .or(`display_name.ilike.${like},first_name.ilike.${like},last_name.ilike.${like}`)
      .limit(10);
    if (error) throw new Error(`search users failed: ${error.message}`);
    return (data as Array<{ id: string; display_name: string | null; first_name: string | null; last_name: string | null }>).map(
      (r) => ({
        id: r.id,
        displayName:
          r.display_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || "Ojo player",
      }),
    );
  }
}
