import { socialForRequest, storeForRequest } from "@/lib/request";
import { storage } from "@/lib/storage";
import { getSupabaseServer } from "@/lib/supabase/server";
import { json, notFound } from "@/lib/util";

export const runtime = "nodejs";

/** The signed-in user's own editable fields — returned only when viewing yourself. */
interface Account {
  email: string | null;
  /** The raw stored display name — blank when unset, unlike `profile.displayName`,
   *  which falls back to a derived one for display. */
  displayName: string;
  firstName: string;
  lastName: string;
  handedness: "left" | "right";
}

/**
 * Your own account fields, for the profile editor. Best-effort on the email:
 * it lives on the auth user rather than `profiles`, and native clients (which
 * authenticate with a Bearer token) already know their own address.
 */
async function accountFields(userId: string): Promise<Account> {
  const supabase = await getSupabaseServer();
  const [auth, row] = await Promise.all([
    supabase.auth.getUser().catch(() => null),
    supabase
      .from("profiles")
      .select("display_name, first_name, last_name, handedness")
      .eq("id", userId)
      .maybeSingle(),
  ]);
  const p = row.data as {
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    handedness: string | null;
  } | null;
  return {
    email: auth?.data.user?.email ?? null,
    displayName: p?.display_name ?? "",
    firstName: p?.first_name ?? "",
    lastName: p?.last_name ?? "",
    handedness: p?.handedness === "left" ? "left" : "right",
  };
}

/**
 * A public profile: display name, follow state/counts, and the user's viewable
 * matches. `id` may be the literal `me`, which resolves to the caller — that way
 * the profile page loads everything it needs in a single request instead of
 * walking a chain of Supabase calls from the browser.
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
    isSelf ? accountFields(id) : null,
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
