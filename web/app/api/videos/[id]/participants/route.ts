import { screen } from "@/lib/moderation/filter";
import { cleanParticipants, saveParticipants } from "@/lib/participants";
import { storeForRequest } from "@/lib/request";
import { getSupabaseServer } from "@/lib/supabase/server";
import { config } from "@/lib/config";
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
 * Replace a match's participant list. Editors only: the owner or any participant
 * (the set_participants RPC enforces this server-side too).
 * Body: { participants: [{ userId?, displayName, email? }] }.
 * Returns the saved list plus every pending invite and its link.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const body = await req.json().catch(() => null);
  const clean = cleanParticipants(body?.participants);

  // A participant name is typed by one player and shown to everyone the match
  // reaches, including people with no account who open a share link — so it is
  // filtered on the same terms as a comment (Guideline 1.2).
  for (const p of clean) {
    const verdict = screen(p.displayName);
    if (!verdict.ok) {
      console.warn(`[moderation] blocked a ${verdict.category} participant name on video ${id}`);
      return json({ error: verdict.message, category: verdict.category }, { status: 422 });
    }
  }

  const before = await store.getParticipants(id);
  const canEdit = !userId || video.ownerId === userId || before.some((p) => p.userId === userId);
  if (!canEdit) return notFound("Video not found");

  const { participants, invites } = await saveParticipants({
    store,
    supabase: config.authEnabled ? await getSupabaseServer() : null,
    userId,
    videoId: id,
    matchTitle: video.title,
    participants: clean,
    before,
  });

  return json({ participants, invites });
}
