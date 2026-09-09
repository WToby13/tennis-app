import { screen } from "@/lib/moderation/filter";
import { socialForRequest, storeForRequest } from "@/lib/request";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Comments for a match, each flagged with whether the caller may delete it and
 * whether they wrote it. Those are different questions — a match owner can
 * delete a comment they did not write — and the moderation menu needs the
 * second one, so it never offers to report you to yourself.
 */
async function listWithPerms(id: string) {
  const [{ social, userId }, { store }] = [await socialForRequest(), await storeForRequest()];
  const video = await store.get(id);
  if (!video) return null;
  const comments = await social.listComments(id);
  const ownerId = video.ownerId;
  return comments.map((c) => ({
    ...c,
    canDelete: !userId || c.authorId === userId || (ownerId != null && ownerId === userId),
    isMine: Boolean(userId && c.authorId === userId),
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

  // Guideline 1.2's "method for filtering objectionable content". Checked here
  // rather than in either client, so the iOS app and the web page get the same
  // answer and neither can be talked out of it. 422 rather than 400: the request
  // is well formed, it is the content that is refused, and the clients tell the
  // two apart to decide whether to show `message` to the person.
  const verdict = screen(text);
  if (!verdict.ok) {
    console.warn(`[moderation] blocked a ${verdict.category} comment on video ${id}`);
    return json({ error: verdict.message, category: verdict.category }, { status: 422 });
  }

  const { social } = await socialForRequest();
  await social.addComment(id, text);
  const comments = await listWithPerms(id);
  return json({ comments: comments ?? [] });
}
