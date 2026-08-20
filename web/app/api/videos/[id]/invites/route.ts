import { inviteUrl, sendParticipantInvites } from "@/lib/email/invites";
import { config } from "@/lib/config";
import { storeForRequest } from "@/lib/request";
import { getSupabaseServer } from "@/lib/supabase/server";
import { displayNameFor } from "@/lib/users";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Pending invites on a match, each with the link that claims it. Editors only —
 * the `participant_invites` RPC enforces that, and the token column isn't
 * readable by a plain select.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const invites = await store.listInvites(id).catch(() => null);
  if (!invites) return notFound("Video not found"); // not an editor

  return json({
    invites: invites
      .filter((i) => !i.claimed && i.token)
      .map((i) => ({ email: i.email, displayName: i.displayName, url: inviteUrl(i.token as string) })),
  });
}

/** Re-send one pending invite. Body: { email }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return badRequest("email is required");

  const invites = await store.listInvites(id).catch(() => null);
  if (!invites) return notFound("Video not found");

  const target = invites.find((i) => i.email.toLowerCase() === email && !i.claimed && i.token);
  if (!target) return badRequest("no pending invite for that address");

  const inviterName = config.authEnabled
    ? await displayNameFor(await getSupabaseServer(), userId)
    : null;
  const [result] = await sendParticipantInvites({
    invites: [{ email: target.email, token: target.token as string }],
    matchTitle: video.title,
    inviterName,
  });

  return json({ sent: result?.sent ?? false, url: result?.url ?? inviteUrl(target.token as string) });
}
