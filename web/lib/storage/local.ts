import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { StorageAdapter, UploadedPart } from "./types";

/**
 * Disk-backed storage adapter for local development.
 *
 * Mirrors S3 multipart semantics: parts land under `.data/uploads/<uploadId>/`,
 * each part's ETag is the md5 of its bytes (as S3 does for a single part), and
 * `complete` concatenates parts in order into `.data/videos/<key>`.
 *
 * Part bytes are PUT by the client to `/api/local-storage/part` (see route),
 * standing in for a presigned S3 URL.
 */

const DATA_DIR = path.join(process.cwd(), ".data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const VIDEOS_DIR = path.join(DATA_DIR, "videos");

function uploadDir(uploadId: string) {
  return path.join(UPLOADS_DIR, uploadId);
}
function partPath(uploadId: string, partNumber: number) {
  return path.join(uploadDir(uploadId), `part-${String(partNumber).padStart(5, "0")}`);
}

/** Write one part's bytes to disk and return its md5 ETag. Called by the local part route. */
export async function writeLocalPart(
  uploadId: string,
  partNumber: number,
  bytes: Buffer,
): Promise<string> {
  await fs.mkdir(uploadDir(uploadId), { recursive: true });
  await fs.writeFile(partPath(uploadId, partNumber), bytes);
  return createHash("md5").update(bytes).digest("hex");
}

/** Absolute path to a finished video file, for the local playback route. */
export function localVideoPath(key: string) {
  return path.join(VIDEOS_DIR, key);
}

export class LocalStorageAdapter implements StorageAdapter {
  async initiateMultipart(key: string): Promise<{ uploadId: string }> {
    const uploadId = randomUUID();
    await fs.mkdir(uploadDir(uploadId), { recursive: true });
    return { uploadId };
  }

  async getPartUploadUrl(key: string, uploadId: string, partNumber: number) {
    const params = new URLSearchParams({
      uploadId,
      partNumber: String(partNumber),
      key,
    });
    return { url: `/api/local-storage/part?${params.toString()}`, method: "PUT" as const };
  }

  async listParts(_key: string, uploadId: string): Promise<UploadedPart[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(uploadDir(uploadId));
    } catch {
      return [];
    }
    const parts: UploadedPart[] = [];
    for (const name of entries) {
      const match = /^part-(\d+)$/.exec(name);
      if (!match) continue;
      const p = partPath(uploadId, Number(match[1]));
      const bytes = await fs.readFile(p);
      parts.push({
        partNumber: Number(match[1]),
        etag: createHash("md5").update(bytes).digest("hex"),
        size: bytes.length,
      });
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    await fs.mkdir(path.dirname(localVideoPath(key)), { recursive: true });
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const out = localVideoPath(key);
    // Fresh file, then append each part in order.
    await fs.writeFile(out, Buffer.alloc(0));
    for (const part of ordered) {
      const bytes = await fs.readFile(partPath(uploadId, part.partNumber));
      await fs.appendFile(out, bytes);
    }
    // Parts are no longer needed once assembled.
    await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
  }

  async abortMultipart(_key: string, uploadId: string): Promise<void> {
    await fs.rm(uploadDir(uploadId), { recursive: true, force: true });
  }

  async getPlaybackUrl(videoId: string): Promise<string> {
    // Served with HTTP range support so the browser can scrub without a full download.
    return `/api/local-storage/video/${videoId}`;
  }
}
