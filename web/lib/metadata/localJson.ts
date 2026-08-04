import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  LibraryEntry,
  MetadataStore,
  Participant,
  ShareLink,
  UserResult,
  Video,
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

let chain: Promise<unknown> = Promise.resolve();
/** Serialize read-modify-write cycles to avoid lost updates. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function readAll(): Promise<Video[]> {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8")) as Video[];
  } catch {
    return [];
  }
}

async function writeAll(videos: Video[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DB_FILE, JSON.stringify(videos, null, 2));
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
      .map((v) => ({ ...v, addedVia: "upload" as const }));
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
}
