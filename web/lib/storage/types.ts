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

  // --- analysis proxy --------------------------------------------------------
  // A temporary, smaller re-encode used only to fit TwelveLabs' input limit.
  // See lib/analysisProxy.ts; deleted as soon as the breakdown finishes.

  /** URL + method for uploading a match's analysis proxy directly to storage. */
  getAnalysisProxyUploadUrl(videoId: string): Promise<{ url: string; method: "PUT" }>;

  /** A URL TwelveLabs can fetch the proxy from. */
  getAnalysisProxyUrl(videoId: string): Promise<string>;

  /** Delete the proxy. Best-effort — it's disposable by definition. */
  deleteAnalysisProxy(videoId: string): Promise<void>;

  /**
   * Whether the proxy object is still there.
   *
   * Proxies are retained for 48 hours so a retry doesn't pay for another
   * transcode, then removed by a bucket lifecycle rule rather than by this app.
   * That means `videos.has_analysis_proxy` can outlive the object it describes,
   * so anything about to *use* a proxy asks storage rather than trusting the
   * flag.
   */
  analysisProxyExists(videoId: string): Promise<boolean>;

  // --- 3D scene --------------------------------------------------------------
  // The match rebuilt in 3D (lib/matchScene.ts), written by the analysis worker
  // and read by the watch page's 3D view. A few MB, so it goes straight to
  // storage rather than through the app.

  /** URL + method the analysis worker uploads a match's scene (JSON) to. */
  getSceneUploadUrl(videoId: string): Promise<{ url: string; method: "PUT" }>;

  /** A URL the browser fetches the scene from (CORS-readable). */
  getSceneUrl(videoId: string): Promise<string>;
}

/** The storage object key for a video's poster thumbnail. Deterministic — no DB column needed. */
export function thumbnailKey(videoId: string): string {
  return `thumbnails/${videoId}.jpg`;
}

/** Where a match's 3D scene lives. Deterministic, like thumbnails. */
export function sceneKey(videoId: string): string {
  return `scenes/${videoId}.json`;
}

/** Where a match's (temporary) analysis proxy lives. Deterministic, like thumbnails. */
export function analysisProxyKey(videoId: string): string {
  return `proxies/${videoId}.mp4`;
}
