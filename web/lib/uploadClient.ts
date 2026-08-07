/**
 * Browser multipart upload client.
 *
 * This is the reference implementation of the exact flow the iOS recorder will
 * follow: initiate → for each part, ask the API for an upload URL and PUT the
 * chunk straight to storage → complete with the collected ETags. Keeping it here
 * lets us exercise (and verify) the whole pipeline from the browser today.
 */

export interface UploadHandle {
  videoId: string;
}

/** Poster-frame timestamp (seconds) and max edge, matching the iOS recorder. */
const THUMBNAIL_SECONDS = 60;
const THUMBNAIL_MAX_EDGE = 640;

/**
 * Grab a poster frame from the file in the browser: 60s in, or the last frame
 * for clips shorter than a minute (mirrors the iOS Thumbnailer). Returns a JPEG
 * blob, or null if the browser can't decode this video — a missing thumbnail is
 * never fatal, and the server-side backfill can cover such files.
 */
async function captureThumbnail(file: File): Promise<Blob | null> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = objectUrl;

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("video decode failed"));
    });

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    // Tolerate a hair before the end so `seeked` fires on a decodable frame.
    const target = duration > THUMBNAIL_SECONDS ? THUMBNAIL_SECONDS : Math.max(0, duration - 0.1);

    await new Promise<void>((resolve, reject) => {
      video.onseeked = () => resolve();
      video.onerror = () => reject(new Error("seek failed"));
      video.currentTime = target;
    });

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // Fit within 640×640 without upscaling.
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.8),
    );
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Best-effort poster thumbnail upload — presign a direct PUT and send the JPEG,
 * the same path the iOS recorder uses. Swallows all errors: the video is already
 * stored, so a thumbnail failure must not fail the upload.
 */
async function uploadThumbnail(videoId: string, file: File): Promise<void> {
  try {
    const blob = await captureThumbnail(file);
    if (!blob) return;
    const presignRes = await fetch(`/api/uploads/${videoId}/thumbnail-url`, { method: "POST" });
    if (!presignRes.ok) return;
    const { url, method } = await presignRes.json();
    await fetch(url, { method, headers: { "content-type": "image/jpeg" }, body: blob });
  } catch {
    // Non-fatal — leave the video thumbnail-less; the backfill can fill it in.
  }
}

export async function uploadFile(
  file: File,
  opts: { title: string; onProgress?: (fraction: number) => void },
): Promise<UploadHandle> {
  const contentType = file.type || "video/mp4";

  // 1. Initiate
  const initRes = await fetch("/api/uploads/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: opts.title, contentType, sizeBytes: file.size }),
  });
  if (!initRes.ok) throw new Error(`initiate failed: ${await initRes.text()}`);
  const { videoId, partSizeBytes } = await initRes.json();

  const partCount = Math.max(1, Math.ceil(file.size / partSizeBytes));
  const parts: { partNumber: number; etag: string; size: number }[] = [];
  let uploadedBytes = 0;

  // 2. Upload each part directly to storage via a per-part URL.
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const start = (partNumber - 1) * partSizeBytes;
    const end = Math.min(file.size, start + partSizeBytes);
    const blob = file.slice(start, end);

    const urlRes = await fetch(`/api/uploads/${videoId}/part-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ partNumber }),
    });
    if (!urlRes.ok) throw new Error(`part-url failed: ${await urlRes.text()}`);
    const { url, method } = await urlRes.json();

    const putRes = await fetch(url, { method, body: blob });
    if (!putRes.ok) throw new Error(`part ${partNumber} upload failed: ${putRes.status}`);
    // S3 requires the bucket CORS to expose the ETag header for this to be readable.
    const etag = (putRes.headers.get("etag") ?? "").replaceAll('"', "");

    parts.push({ partNumber, etag, size: blob.size });
    uploadedBytes += blob.size;
    opts.onProgress?.(uploadedBytes / file.size);
  }

  // 3. Complete
  const completeRes = await fetch(`/api/uploads/${videoId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  if (!completeRes.ok) throw new Error(`complete failed: ${await completeRes.text()}`);

  // 4. Best-effort poster thumbnail (60s in / last frame). Never fails the upload.
  await uploadThumbnail(videoId, file);

  return { videoId };
}
