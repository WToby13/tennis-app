import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { metadata } from "@/lib/metadata";
import { localVideoPath } from "@/lib/storage/local";
import { notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Serve a finished local video with HTTP Range support, so the browser can seek
 * and scrub without downloading the whole file. This is what CloudFront does for
 * us in prod; here we do it by hand off disk.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const video = await metadata().get(id);
  if (!video || video.status !== "ready") return notFound("Video not ready");

  const filePath = localVideoPath(video.key);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return notFound("File missing");
  }

  const contentType = video.contentType || "video/mp4";
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match?.[1] ? Number(match[1]) : 0;
    let end = match?.[2] ? Number(match[2]) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes" },
      });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end }));
    return new Response(stream as unknown as ReadableStream, {
      status: 206,
      headers: {
        "content-type": contentType,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath));
  return new Response(stream as unknown as ReadableStream, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-length": String(size),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    },
  });
}
