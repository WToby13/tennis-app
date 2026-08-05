import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Delete a comment. RLS enforces author-or-match-owner. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; commentId: string }> },
) {
  const { commentId } = await params;
  const { social } = await socialForRequest();
  await social.deleteComment(commentId);
  return json({ ok: true });
}
