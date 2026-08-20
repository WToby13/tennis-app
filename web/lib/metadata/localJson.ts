import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  InvitePreview,
  LibraryEntry,
  MetadataStore,
  Participant,
  ParticipantInvite,
  ShareLink,
  UserResult,
  Video,
  VideoSegment,
} from "./types";

/**
 * Dead-simple JSON-file metadata store for local dev. Reads/writes the whole
 * file under a per-process mutex — fine for one user + a handful of videos.
 * In prod this is replaced by Supabase/Postgres (same MetadataStore interface).
 *
 * Local mode is single-user with no auth, so the sharing concepts collapse:
 * everything is "yours", a share token is just the video id, and adding a shared
 * video is a no-op. The real multi-user behaviour lives in the Supabase store.
 */
const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "videos.json");
const SEGMENTS_FILE = path.join(DATA_DIR, "segments.json");

let chain: Promise<unknown> = Promise.resolve();
/** Serialize read-modify-write cycles to avoid lost updates. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

/** Default analysis fields for rows written before those columns existed. */
function normalize(v: Video): Video {
  return {
    ...v,
    analysisStatus: v.analysisStatus ?? "none",
    analysisTaskId: v.analysisTaskId ?? null,
    analysisWindows: v.analysisWindows ?? null,
    analysisError: v.analysisError ?? null,
    analyzedAt: v.analyzedAt ?? null,
    analysisPlayers: v.analysisPlayers ?? null,
    hasAnalysisProxy: v.hasAnalysisProxy ?? false,
  };
}

async function readAll(): Promise<Video[]> {
  try {
    return (JSON.parse(await fs.readFile(DB_FILE, "utf8")) as Video[]).map(normalize);
  } catch {
    return [];
  }
}

async function writeAll(videos: Video[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(videos, null, 2));
}

/** Local segment row carries its videoId (no relational store to join through). */
type StoredSegment = VideoSegment & { videoId: string };

async function readSegments(): Promise<StoredSegment[]> {
  try {
    return JSON.parse(await fs.readFile(SEGMENTS_FILE, "utf8")) as StoredSegment[];
  } catch {
    return [];
  }
}

async function writeSegments(segments: StoredSegment[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(SEGMENTS_FILE, JSON.stringify(segments, null, 2));
}

export class LocalJsonMetadataStore implements MetadataStore {
  create(video: Video): Promise<Video> {
    return withLock(async () => {
      const all = await readAll();
      all.push(video);
      await writeAll(all);
      return video;
    });
  }

  async get(id: string): Promise<Video | null> {
    const all = await readAll();
    const v = all.find((x) => x.id === id) ?? null;
    return v && !v.deletedAt ? v : null;
  }

  async list(): Promise<LibraryEntry[]> {
    const all = await readAll();
    return all
      .filter((v) => !v.deletedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((v) => ({
        ...v,
        addedVia: "upload" as const,
        // Local mode has no share-link table and no followers — share status
        // comes from `visibility` alone.
        hasActiveShareLink: false,
        sharedToFollowers: false,
      }));
  }

  async listByOwner(): Promise<Video[]> {
    const all = await readAll();
    return all.filter((v) => !v.deletedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listInFlightAnalyses(limit = 50): Promise<Video[]> {
    const all = await readAll();
    return all
      .filter((v) => !v.deletedAt && v.analysisStatus === "processing")
      .slice(0, limit);
  }

  update(id: string, patch: Partial<Video>): Promise<Video> {
    return withLock(async () => {
      const all = await readAll();
      const idx = all.findIndex((v) => v.id === id);
      if (idx === -1) throw new Error(`Video ${id} not found`);
      all[idx] = { ...all[idx], ...patch, id: all[idx].id };
      await writeAll(all);
      return all[idx];
    });
  }

  setTitle(id: string, title: string): Promise<Video> {
    return this.update(id, { title });
  }

  softDelete(id: string): Promise<void> {
    return withLock(async () => {
      const all = await readAll();
      const idx = all.findIndex((v) => v.id === id);
      if (idx === -1) return;
      all[idx] = { ...all[idx], deletedAt: new Date().toISOString() };
      await writeAll(all);
    });
  }

  delete(id: string): Promise<void> {
    return withLock(async () => {
      const all = await readAll();
      await writeAll(all.filter((v) => v.id !== id));
    });
  }

  // In local mode the token *is* the video id — sharing has no separate table.
  async createShareLink(videoId: string): Promise<ShareLink> {
    return { token: videoId };
  }

  getByShareToken(token: string): Promise<Video | null> {
    return this.get(token);
  }

  async hasActiveShareLink(): Promise<boolean> {
    return false; // no share-link table in local mode
  }

  addToLibrary(token: string): Promise<Video | null> {
    return this.get(token); // already "yours" — nothing to add
  }

  removeFromLibrary(videoId: string): Promise<void> {
    return this.softDelete(videoId);
  }

  // Participants are a multi-user concept; local dev is single-user, so these
  // are inert (the real behaviour lives in the Supabase store).
  async getParticipants(): Promise<Participant[]> {
    return [];
  }

  async setParticipants(): Promise<Participant[]> {
    return [];
  }

  async searchUsers(): Promise<UserResult[]> {
    return [];
  }

  // Invites need a second person to invite, so they are inert here too.
  async listInvites(): Promise<ParticipantInvite[]> {
    return [];
  }

  async invitePreview(): Promise<InvitePreview | null> {
    return null;
  }

  async claimInvite(): Promise<string | null> {
    return null;
  }

  async getSegments(videoId: string, kind = "rally"): Promise<VideoSegment[]> {
    const all = await readSegments();
    return all
      .filter((s) => s.videoId === videoId && s.kind === kind)
      .sort((a, b) => a.idx - b.idx)
      .map(({ videoId: _v, ...seg }) => seg);
  }

  replaceSegments(
    videoId: string,
    kind: string,
    segments: Omit<VideoSegment, "id">[],
  ): Promise<void> {
    return withLock(async () => {
      const all = await readSegments();
      const others = all.filter((s) => !(s.videoId === videoId && s.kind === kind));
      const rows: StoredSegment[] = segments.map((s, i) => ({
        ...s,
        id: `${videoId}-${kind}-${i}`,
        videoId,
      }));
      await writeSegments([...others, ...rows]);
    });
  }
}
