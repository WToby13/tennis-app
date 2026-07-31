export type VideoStatus = "uploading" | "processing" | "ready" | "failed";

export interface Video {
  id: string;
  /** Supabase auth user id of the recorder; null in local (no-auth) mode. */
  ownerId: string | null;
  title: string;
  /** Storage object key. */
  key: string;
  /** Storage multipart upload id (present while uploading). */
  uploadId: string | null;
  contentType: string;
  sizeBytes: number;
  partSizeBytes: number;
  durationS: number | null;
  status: VideoStatus;
  recordedAt: string | null;
  createdAt: string;
}

export interface MetadataStore {
  create(video: Video): Promise<Video>;
  get(id: string): Promise<Video | null>;
  list(): Promise<Video[]>;
  update(id: string, patch: Partial<Video>): Promise<Video>;
}
