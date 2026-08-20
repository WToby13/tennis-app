import { loadAccount } from "@/lib/library";
import { socialForRequest, storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { getSupabaseServiceRole, serviceRoleConfigured } from "@/lib/supabase/service";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/**
 * A public profile: display name, follow state/counts, and the user's viewable
 * matches. `id` may be the literal `me`, which resolves to the caller — that way
 * a client needing its own profile doesn't have to look up its id first.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: requested } = await params;
  const { social, userId } = await socialForRequest();
  const { store } = await storeForRequest();

  const id = requested === "me" ? userId : requested;
  if (!id) return notFound("User not found");
  const isSelf = Boolean(userId && userId === id);

  const [profile, videos, account] = await Promise.all([
    social.profileSummary(id),
    store.listByOwner(id),
    isSelf ? loadAccount(id) : null,
  ]);
  if (!profile) return notFound("User not found");

  const withThumbs = await Promise.all(
    videos.map(async (v) => ({
      id: v.id,
      title: v.title,
      status: v.status,
      durationS: v.durationS,
      sizeBytes: v.sizeBytes,
      createdAt: v.createdAt,
      thumbnailUrl: await storage()
        .getThumbnailUrl(v.id)
        .catch(() => null),
    })),
  );

  return json({ profile, videos: withThumbs, isSelf, account });
}

/**
 * Delete the caller's account, for real.
 *
 * App Store Review Guideline 5.1.1(v): an app that lets you create an account
 * must let you delete it from inside the app — not by emailing support, and not
 * merely deactivating it. Only `me` (or your own id) is accepted; there is no
 * path here to delete anybody else.
 *
 * Order matters, in three steps.
 *
 * 1. Purge the video bytes, while the rows that name them still exist. Doing
 *    this after the cascade would orphan objects in S3 with nothing left
 *    pointing at them.
 * 2. Scrub the rows the database will *not* take with it. Almost every FK to
 *    `auth.users` is ON DELETE CASCADE, but `video_participants.user_id` is ON
 *    DELETE SET NULL — so a participant row on somebody else's match survives
 *    the delete still carrying this person's name and email address. Nulling
 *    the id is not erasure; the identifying columns have to go too. The slot
 *    itself stays, because the match genuinely had two players in it and
 *    removing one would rewrite another user's record of their own game.
 * 3. Delete the auth user and let the cascades run (profiles, videos, follows,
 *    likes, comments, library items, shares, blocks and filed reports).
 *
 * Covered by `supabase/tests/moderation_test.sql` §6.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: requested } = await params;
  const { store, userId } = await storeForRequest();

  if (!userId) return json({ error: "Not signed in" }, { status: 401 });
  if (requested !== "me" && requested !== userId) return notFound("User not found");

  if (!serviceRoleConfigured()) {
    // Deleting from auth.users needs the service role. Failing loudly beats
    // reporting success and leaving the account alive.
    console.error("[account] SUPABASE_SERVICE_ROLE_KEY unset — cannot delete account");
    return json({ error: "Account deletion is unavailable right now" }, { status: 503 });
  }

  // Best-effort per asset: one stubborn object must not strand the account in a
  // half-deleted state, and the row cascade below is what actually makes it gone.
  const owned = await store.listByOwner(userId);
  await Promise.all(
    owned.map(async (v) => {
      await storage()
        .deleteVideoAssets(v.id, v.key)
        .catch((err) => console.error(`[account] purge ${v.id} failed`, err));
      await storage()
        .deleteAnalysisProxy(v.id)
        .catch(() => {});
    }),
  );

  const admin = getSupabaseServiceRole();

  // Step 2: anonymise the participant rows the SET NULL FK would otherwise leave
  // behind on other people's matches, still carrying this person's name and
  // email. Service role, because RLS only lets a match's editors write here and
  // the person leaving is not one of them.
  const { error: scrubError } = await admin
    .from("video_participants")
    .update({ display_name: "Former Ojo player", email: null, invite_token: null })
    .eq("user_id", userId);
  if (scrubError) {
    // Refuse rather than half-delete: the account surviving is recoverable,
    // personal data left on someone else's match after a delete is not.
    console.error("[account] participant scrub failed", scrubError);
    return json({ error: "Couldn't delete your account" }, { status: 500 });
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error("[account] deleteUser failed", error);
    return json({ error: "Couldn't delete your account" }, { status: 500 });
  }

  return json({ deleted: true });
}
