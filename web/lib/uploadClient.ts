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

  return { videoId };
}
