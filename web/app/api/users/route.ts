import { storeForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Search Ojo users by name.
 *
 * `scope=following` narrows it to people the caller follows — what the comment
 * @ picker asks for, since you can only tag someone you follow. Without it this
 * is the whole directory, which is what People Search and the participant
 * picker want.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const q = params.get("q")?.trim() ?? "";
  if (q.length < 2) return json({ users: [] });
  const { store } = await storeForRequest();
  return json({ users: await store.searchUsers(q, params.get("scope") === "following") });
}
