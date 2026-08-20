import { socialForRequest } from "@/lib/request";
import { badRequest, json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Block / unblock a user. Blocking hides their matches and comments from the
 * caller and the caller's from them, and drops any follow between the two.
 *
 * Required by App Store Review Guideline 1.2 alongside `/api/reports`.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social, userId } = await socialForRequest();
  if (userId && userId === id) return badRequest("You can't block yourself");
  await social.blockUser(id);
  return json({ blocked: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.unblockUser(id);
  return json({ blocked: false });
}
