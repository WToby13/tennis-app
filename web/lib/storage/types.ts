/**
 * Storage adapter — the contract the multipart API depends on.
 *
 * The client (browser today, iOS tomorrow) never sends bytes through our API:
 * `getPartUploadUrl` returns a URL the client PUTs a chunk to directly. In prod
 * that's a presigned S3 URL; in local dev it's a route that writes to disk. The
 * initiate → part-url → complete flow is identical either way.
 */

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface StorageAdapter {
  /** Start a multipart upload. Returns the storage upload id. */
  initiateMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;

  /** URL + HTTP method the client should use to upload one part directly to storage. */
  getPartUploadUrl(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<{ url: string; method: "PUT" }>;

  /** Parts already uploaded — used to resume an interrupted upload. */
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;

  /** Finish the upload, assembling the parts into the final object. */
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;

  /** Discard an incomplete upload and its parts. */
  abortMultipart(key: string, uploadId: string): Promise<void>;

  /** A URL the browser can use to stream/scrub the finished object. */
  getPlaybackUrl(videoId: string, key: string): Promise<string>;

  /** URL + method the client uses to upload a video's poster thumbnail (a JPEG) directly to storage. */
  getThumbnailUploadUrl(videoId: string): Promise<{ url: string; method: "PUT" }>;

  /** A URL to fetch a video's thumbnail. May 403/404 if none was uploaded — callers handle that gracefully. */
  getThumbnailUrl(videoId: string): Promise<string>;

  /** Permanently delete a video's object and its thumbnail. Best-effort per asset. */
  deleteVideoAssets(videoId: string, key: string): Promise<void>;
}

/** The storage object key for a video's poster thumbnail. Deterministic — no DB column needed. */
export function thumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}.jpg`;
}
