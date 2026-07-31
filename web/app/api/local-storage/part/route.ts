import { writeLocalPart } from "@/lib/storage/local";
import { badRequest } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Local stand-in for a presigned S3 UploadPart URL. The client PUTs raw part
 * bytes here; we persist them and return the md5 ETag in the `etag` header,
 * exactly as S3 returns an ETag for an uploaded part.
 */
export async function PUT(req: Request) {
  const url = new URL(req.url);
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return badRequest("uploadId and a positive partNumber are required");
  }

  const bytes = Buffer.from(await req.arrayBuffer());
  const etag = await writeLocalPart(uploadId, partNumber, bytes);

  return new Response(null, { status: 200, headers: { etag } });
}
