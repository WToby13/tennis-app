import { applyCorrections, parseCorrections, reindex, withoutIds } from "@/lib/rallyEdits";
import { storeForRequest } from "@/lib/request";
import { RALLY_KIND } from "@/lib/twelvelabs/rally";
import { badRequest, json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Hand corrections to a match's rally breakdown. Editors only — the owner or a
 * tagged participant, the same rights `replace_video_segments` enforces itself.
 *
 * Body: {
 *   servers?: { "<rally idx>": "player_1" | "player_2" },  // who actually served
 *   deleted?: number[]                                     // rallies to drop
 * }
 *
 * The rally *timings* are the part of the analysis that is reliably right (they
 * come from the video's own gaps, not from a model's vote), so they are never
 * taken from the request at all: the stored segments are loaded, the named ones
 * are corrected or dropped, and everything derived — receiver, serving side,
 * the service-game grouping, and the ordering index — is rebuilt server-side.
 * An edit therefore cannot reshape the breakdown, whatever it sends.
 *
 * Returns the saved segments, whose ids are new: replaceSegments is a delete +
 * insert, so the caller has to take these rather than keep the ones it had.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store, userId } = await storeForRequest();

  const video = await store.get(id);
  if (!video) return notFound("Video not found");

  const participants = await store.getParticipants(id).catch(() => []);
  const canEdit =
    !userId || video.ownerId === userId || participants.some((p) => p.userId === userId);
  if (!canEdit) return notFound("Video not found");

  const parsed = parseCorrections(await req.json().catch(() => null));
  if ("error" in parsed) return badRequest(parsed.error);
  const { corrections } = parsed;

  const before = await store.getSegments(id, RALLY_KIND);
  if (before.length === 0) return badRequest("This match has no rally breakdown to correct.");

  const named = [...Object.keys(corrections.servers).map(Number), ...corrections.deleted];
  const unknown = named.find((idx) => !before.some((s) => s.idx === idx));
  if (unknown !== undefined) return badRequest(`No rally ${unknown} in this match.`);

  await store.replaceSegments(
    id,
    RALLY_KIND,
    withoutIds(reindex(applyCorrections(before, corrections))),
  );

  return json({ segments: await store.getSegments(id, RALLY_KIND) });
}
