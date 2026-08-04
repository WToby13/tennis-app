import { storeForRequest } from "@/lib/request";
import { badRequest, json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * "Add to my account": add a shared video to the caller's library via a valid
 * share token. Body: { token }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const token = body?.token;
  if (typeof token !== "string" || !token) return badRequest("token is required");

  const { store } = await storeForRequest();
  const video = await store.addToLibrary(token);
  if (!video || video.id !== id) return badRequest("invalid or expired share link");

  return json({ ok: true, video });
}
