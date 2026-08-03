import { readFile } from "node:fs/promises";
import { localThumbnailPath, writeLocalThumbnail } from "@/lib/storage/local";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Local-dev stand-in for a presigned S3 PUT: store a video's thumbnail JPEG. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bytes = Buffer.from(await req.arrayBuffer());
  await writeLocalThumbnail(id, bytes);
  return json({ ok: true });
}

/** Serve a stored thumbnail (mirrors CloudFront serving `thumbnails/<id>.jpg` in prod). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let bytes: Buffer;
  try {
    bytes = await readFile(localThumbnailPath(id));
  } catch {
    return notFound("No thumbnail");
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
  });
}
