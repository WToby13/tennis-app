import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

/** Like a match. Returns the updated like state. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.setLike(id, true);
  return json(await social.likeState(id));
}

/** Unlike a match. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.setLike(id, false);
  return json(await social.likeState(id));
}
