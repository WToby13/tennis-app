import { readFile } from "node:fs/promises";
import { localScenePath, writeLocalScene } from "@/lib/storage/local";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Local-dev stand-in for a presigned S3 PUT: store a match's 3D scene. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await writeLocalScene(id, Buffer.from(await req.arrayBuffer()));
  return json({ ok: true });
}

/** Serve a stored scene (mirrors CloudFront serving `scenes/<id>.json` in prod). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let bytes: Buffer;
  try {
    bytes = await readFile(localScenePath(id));
  } catch {
    return notFound("No scene");
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
