import { storeForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Search Ojo users by name, for tagging as match participants. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return json({ users: [] });
  const { store } = await storeForRequest();
  return json({ users: await store.searchUsers(q) });
}
