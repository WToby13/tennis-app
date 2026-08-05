import { socialForRequest } from "@/lib/request";
import { json } from "@/lib/util";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.follow(id);
  return json({ following: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { social } = await socialForRequest();
  await social.unfollow(id);
  return json({ following: false });
}
