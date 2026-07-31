import type { SupabaseClient } from "@supabase/supabase-js";
import type { MetadataStore, Video } from "./types";

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
  recorded_at: string | null;
  created_at: string;
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
    recordedAt: r.recorded_at,
    createdAt: r.created_at,
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
  if (patch.recordedAt !== undefined) row.recorded_at = patch.recordedAt;
  return row;
}

/**
 * Postgres-backed metadata store. Uses a request-scoped Supabase client, so all
 * reads/writes run under the signed-in user's RLS policies.
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

  async list(): Promise<Video[]> {
    const { data, error } = await this.supabase
      .from("videos")
      .select()
      .order("created_at", { ascending: false });
    if (error) throw new Error(`list videos failed: ${error.message}`);
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
}
