export type VideoStatus = "uploading" | "processing" | "ready" | "failed";

/**
 * Who can read a video, beyond its owner + people it's explicitly shared to.
 * 'private' today; 'public' is the future social-feed read path (already honoured
 * by the RLS + playback checks so turning it on later is a UI change only).
 */
export type VideoVisibility = "private" | "unlisted" | "public";

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
  visibility: VideoVisibility;
  recordedAt: string | null;
  createdAt: string;
  /** Soft-delete marker; a non-null value means the video is gone (bytes purged). */
  deletedAt: string | null;
}

/** A video as it appears in a user's library, tagged with how it got there. */
export interface LibraryEntry extends Video {
  addedVia: "upload" | "share";
}

export interface ShareLink {
  token: string;
}

export interface MetadataStore {
  create(video: Video): Promise<Video>;
  get(id: string): Promise<Video | null>;
  /** The caller's library (videos they uploaded or added), newest first. */
  list(): Promise<LibraryEntry[]>;
  update(id: string, patch: Partial<Video>): Promise<Video>;
  /** Soft-delete: mark deleted, hide everywhere. Byte purge is a separate step. */
  softDelete(id: string): Promise<void>;
  /** Hard-delete the metadata row (local mode / admin purge). */
  delete(id: string): Promise<void>;

  // --- sharing ---------------------------------------------------------------
  /** Mint (or reuse) a revocable share link for a video the caller owns. */
  createShareLink(videoId: string, createdBy: string | null): Promise<ShareLink>;
  /** Resolve a share token → its video, or null if the token is invalid/expired. */
  getByShareToken(token: string): Promise<Video | null>;
  /** Add a shared video to the caller's library via a valid token. */
  addToLibrary(token: string): Promise<Video | null>;
  /** Remove a video from the caller's own library (does not delete the video). */
  removeFromLibrary(videoId: string, userId: string | null): Promise<void>;
}
