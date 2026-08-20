import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Accounts the caller has blocked — the "Blocked accounts" management screen. */
export async function GET() {
  const { social } = await socialForRequest();
  return json({ blocked: await social.listBlocked() });
}
