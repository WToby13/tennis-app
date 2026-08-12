import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedUrl as getSignedCloudFrontUrl } from "@aws-sdk/cloudfront-signer";
import { config } from "../config";
import { analysisProxyKey, thumbnailKey, type StorageAdapter, type UploadedPart } from "./types";

/**
 * How often a signed playback/thumbnail URL is allowed to change. Signing with a
 * raw `now + ttl` expiry produces a different signature on every request, so the
 * browser treats each one as a new resource and re-downloads it — every visit to
 * the library or feed refetched every thumbnail. Rounding the expiry UP to a
 * fixed bucket means all requests within the same bucket get a byte-identical
 * URL (cacheable), while validity is always at least the configured TTL.
 */
const URL_STABILITY_BUCKET_SECONDS = 60 * 60;

/** An expiry that's stable within the bucket and never shorter than the TTL. */
function stableExpiry(ttlSeconds: number): Date {
  const earliest = Date.now() / 1000 + ttlSeconds;
  const bucket = URL_STABILITY_BUCKET_SECONDS;
  return new Date(Math.ceil(earliest / bucket) * bucket * 1000);
}

/**
 * Real S3 multipart adapter. Enabled with STORAGE_BACKEND=s3.
 *
 * Uploads: bytes go straight from the client to S3 via presigned UploadPart URLs.
 * Playback: a CloudFront URL, signed when a key pair is configured (required for
 * a private bucket fronted by a CloudFront key group).
 */
export class S3StorageAdapter implements StorageAdapter {
  private client = new S3Client({ region: config.aws.region });
  private bucket = config.aws.bucket;

  async initiateMultipart(key: string, contentType: string): Promise<{ uploadId: string }> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error("S3 did not return an UploadId");
    return { uploadId: res.UploadId };
  }

  async getPartUploadUrl(key: string, uploadId: string, partNumber: number) {
    const url = await getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: 3600 },
    );
    return { url, method: "PUT" as const };
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const res = await this.client.send(
      new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
    return (res.Parts ?? []).map((p) => ({
      partNumber: p.PartNumber!,
      etag: (p.ETag ?? "").replaceAll('"', ""),
      size: p.Size,
    }));
  }

  async completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: `"${p.etag.replaceAll('"', "")}"` })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
    );
  }

  async getPlaybackUrl(_videoId: string, key: string): Promise<string> {
    const { domain, signUrls, keyPairId, privateKey, signedUrlTtlSeconds } = config.cloudfront;
    if (!domain) throw new Error("CLOUDFRONT_DOMAIN is not set");

    const url = `https://${domain}/${key}`;
    if (!signUrls) return url; // public distribution (not recommended for private video)

    return getSignedCloudFrontUrl({
      url,
      keyPairId,
      privateKey,
      dateLessThan: stableExpiry(signedUrlTtlSeconds).toISOString(),
    });
  }

  async deleteVideoAssets(videoId: string, key: string): Promise<void> {
    const del = (k: string) =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k })).catch(() => {});
    // The proxy would otherwise outlive the match by up to 48 hours (it's the
    // lifecycle rule that normally removes it, not this app). Deleting a match
    // must take its bytes with it, so this removes it now.
    await Promise.all([del(key), del(thumbnailKey(videoId)), del(analysisProxyKey(videoId))]);
  }

  async getThumbnailUploadUrl(videoId: string) {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: thumbnailKey(videoId),
        ContentType: "image/jpeg",
      }),
      { expiresIn: 3600 },
    );
    return { url, method: "PUT" as const };
  }

  async getThumbnailUrl(videoId: string): Promise<string> {
    const { domain, signUrls, keyPairId, privateKey, signedUrlTtlSeconds } = config.cloudfront;
    if (!domain) throw new Error("CLOUDFRONT_DOMAIN is not set");

    const url = `https://${domain}/${thumbnailKey(videoId)}`;
    if (!signUrls) return url;

    return getSignedCloudFrontUrl({
      url,
      keyPairId,
      privateKey,
      dateLessThan: stableExpiry(signedUrlTtlSeconds).toISOString(),
    });
  }

  async getAnalysisProxyUploadUrl(videoId: string) {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: analysisProxyKey(videoId),
        ContentType: "video/mp4",
      }),
      { expiresIn: 3600 },
    );
    return { url, method: "PUT" as const };
  }

  async getAnalysisProxyUrl(videoId: string): Promise<string> {
    const { domain, signUrls, keyPairId, privateKey } = config.cloudfront;
    if (!domain) throw new Error("CLOUDFRONT_DOMAIN is not set");

    const url = `https://${domain}/${analysisProxyKey(videoId)}`;
    if (!signUrls) return url;

    // NOT the stable-expiry helper: this URL is handed to TwelveLabs, which may
    // hold it for the length of a long analysis, so it gets its own generous
    // window rather than one tuned for browser caching.
    return getSignedCloudFrontUrl({
      url,
      keyPairId,
      privateKey,
      dateLessThan: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  async deleteAnalysisProxy(videoId: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: analysisProxyKey(videoId) }))
      .catch(() => {});
  }

  async analysisProxyExists(videoId: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: analysisProxyKey(videoId) }),
      );
      return true;
    } catch {
      // 404 (lifecycle-expired) and 403 alike mean "don't try to analyse it".
      return false;
    }
  }
}
