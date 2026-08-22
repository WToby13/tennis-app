import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * The caller's notification inbox, newest first, with the unread tally the bell
 * badges itself with.
 *
 * The count is derived from the same rows rather than being its own query: the
 * list is capped well above what anyone accumulates between visits, and a
 * separate count could disagree with what is on screen (the RPC drops rows for
 * matches the caller can no longer open).
 */
export async function GET() {
  const { social } = await socialForRequest();
  const notifications = await social.listNotifications(50);
  return json({
    notifications,
    unreadCount: notifications.filter((n) => !n.readAt).length,
  });
}
