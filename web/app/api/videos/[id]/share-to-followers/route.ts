import { track } from "@/lib/analytics/server";
import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Post this match to my followers' feeds. RLS requires me to be owner/participant. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social, userId } = await socialForRequest();
  await social.setSharedToFollowers(id, true);
  track("match_shared", { userId, videoId: id, props: { channel: "followers" } });
  return json({ shared: true });
}

/** Stop sharing this match with my followers. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.setSharedToFollowers(id, false);
  return json({ shared: false });
}
