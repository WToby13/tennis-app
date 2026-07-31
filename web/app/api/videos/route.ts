import { storeForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** List all videos, newest first. */
export async function GET() {
  const { store } = await storeForRequest();
  const videos = await store.list();
  return json({ videos });
}
