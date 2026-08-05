import { socialForRequest, storeForRequest } from "@/lib/request";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Comments for a match, each flagged with whether the caller may delete it. */
async function listWithPerms(id: string) {
  const [{ social, userId }, { store }] = [await socialForRequest(), await storeForRequest()];
  const video = await store.get(id);
  if (!video) return null;
  const comments = await social.listComments(id);
  const ownerId = video.ownerId;
  return comments.map((c) => ({
    ...c,
    canDelete: !userId || c.authorId === userId || (ownerId != null && ownerId === userId),
  }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const comments = await listWithPerms(id);
  if (comments === null) return notFound("Video not found");
  return json({ comments });
}

/** Add a comment (anyone who can see the match). Returns the refreshed list. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (!text) return badRequest("comment body is required");

  const { social } = await socialForRequest();
  await social.addComment(id, text);
  const comments = await listWithPerms(id);
  return json({ comments: comments ?? [] });
}
