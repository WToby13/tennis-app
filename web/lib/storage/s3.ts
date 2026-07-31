import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getSignedUrl as getSignedCloudFrontUrl } from "@aws-sdk/cloudfront-signer";
import { config } from "../config";
import type { StorageAdapter, UploadedPart } from "./types";

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
      dateLessThan: new Date(Date.now() + signedUrlTtlSeconds * 1000).toISOString(),
    });
  }
}
