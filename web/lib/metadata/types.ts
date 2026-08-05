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
  addedVia: "upload" | "share" | "participant";
}

export interface ShareLink {
  token: string;
}

/** Someone who played in a match — a linked Ojo user or a guest (optionally by email). */
export interface Participant {
  id: string;
  /** Linked Ojo user id, or null for a guest / not-yet-joined invite. */
  userId: string | null;
  displayName: string;
  email: string | null;
}

/** A participant as supplied by a client when setting the list (no id yet). */
export interface ParticipantInput {
  userId: string | null;
  displayName: string;
  email: string | null;
}

/** A user found via search, for tagging as a participant. */
export interface UserResult {
  id: string;
  displayName: string;
}

export interface MetadataStore {
  create(video: Video): Promise<Video>;
  get(id: string): Promise<Video | null>;
  /** The caller's library (videos they uploaded or added), newest first. */
  list(): Promise<LibraryEntry[]>;
  /** A given owner's videos that the caller may see (RLS-filtered), newest first. */
  listByOwner(ownerId: string): Promise<Video[]>;
  update(id: string, patch: Partial<Video>): Promise<Video>;
  /** Rename a match. Allowed for the owner or any participant (editors). */
  setTitle(id: string, title: string): Promise<Video>;
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

  // --- participants ----------------------------------------------------------
  /** Who played in a match. */
  getParticipants(videoId: string): Promise<Participant[]>;
  /** Replace a match's participant list. Editors only (owner or participant). */
  setParticipants(videoId: string, participants: ParticipantInput[]): Promise<Participant[]>;
  /** Search Ojo users by name, for tagging. */
  searchUsers(query: string): Promise<UserResult[]>;
}
