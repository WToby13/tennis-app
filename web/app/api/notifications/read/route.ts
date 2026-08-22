import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Mark notifications read: the ones named in `ids`, or the whole inbox when the
 * body is empty (what opening the bell does).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const ids = Array.isArray(body?.ids)
    ? (body.ids as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;

  const { social } = await socialForRequest();
  await social.markNotificationsRead(ids);
  return json({ ok: true });
}
