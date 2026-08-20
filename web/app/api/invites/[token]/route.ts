import { storeForRequest } from "@/lib/request";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * What an invite link should show before you have an account: the match, who
 * invited you, and the address it was sent to (so the sign-up form can prefill
 * it). Public by design — anyone holding the token was sent it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { store, userId } = await storeForRequest();

  const preview = await store.invitePreview(token).catch(() => null);
  if (!preview) return notFound("This invite link is no longer valid");

  return json({ invite: preview, signedIn: Boolean(userId) });
}

/**
 * Claim the invite as the signed-in caller: link the participant row, grant
 * library access, and take the placeholder name off them.
 *
 * The token is the proof — not a matching email address — so this works whatever
 * they signed up with, which is the whole point of the invite flow.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { store, userId } = await storeForRequest();
  if (!userId) return badRequest("Sign in to accept this invite");

  const videoId = await store.claimInvite(token);
  if (!videoId) return badRequest("This invite link is no longer valid");

  return json({ videoId });
}
