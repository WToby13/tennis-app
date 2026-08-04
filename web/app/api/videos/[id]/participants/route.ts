import { sendParticipantInvites } from "@/lib/email/invites";
import { storeForRequest } from "@/lib/request";
import type { ParticipantInput } from "@/lib/metadata";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** Read who played in a match. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await storeForRequest();
  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  return json({ participants: await store.getParticipants(id) });
}

/**
 * Replace a match's participant list. Owner-only (RLS also enforces this).
 * Body: { participants: [{ userId?, displayName, email? }] }.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");
  if (userId && video.ownerId && video.ownerId !== userId) return notFound("Video not found");

  const body = await req.json().catch(() => null);
  const raw = Array.isArray(body?.participants) ? body.participants : [];
  const clean: ParticipantInput[] = raw
    .map((p: unknown) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const displayName = typeof o.displayName === "string" ? o.displayName.trim() : "";
      const userIdVal = typeof o.userId === "string" && o.userId ? o.userId : null;
      const emailVal =
        typeof o.email === "string" && o.email.trim() ? o.email.trim().toLowerCase() : null;
      return { userId: userIdVal, displayName, email: emailVal };
    })
    .filter((p: ParticipantInput) => p.displayName.length > 0);

  // Only email guests that are newly added (don't re-invite on every edit).
  const before = await store.getParticipants(id);
  const known = new Set(before.filter((p) => p.email).map((p) => p.email!.toLowerCase()));

  const participants = await store.setParticipants(id, clean, userId);

  const newEmails = clean
    .filter((p) => p.userId === null && p.email && !known.has(p.email.toLowerCase()))
    .map((p) => p.email as string);
  if (newEmails.length) {
    await sendParticipantInvites({ videoId: id, matchTitle: video.title, emails: newEmails });
  }

  return json({ participants });
}
