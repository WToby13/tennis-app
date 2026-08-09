import { deriveMatchStatus } from "./matchStatus";
import type { MatchStatus } from "./matchStatus";
import type { LibraryEntry } from "./metadata/types";
import { storeForRequest, socialForRequest } from "./request";
import { storage } from "./storage";
import { getSupabaseServer } from "./supabase/server";

/** A library entry as both the API route and the server-rendered page serve it. */
export type LibraryItem = LibraryEntry & {
  thumbnailUrl: string | null;
  matchStatus: MatchStatus;
};

/**
 * The caller's library, newest first, with thumbnails and derived status.
 *
 * Shared by `GET /api/videos` and the server-rendered library page so the two
 * can't drift — the page renders the same objects the client later re-fetches.
 */
export async function loadLibrary(): Promise<LibraryItem[]> {
  const { store } = await storeForRequest();
  const videos = await store.list();
  return Promise.all(
    videos.map(async (v) => ({
      ...v,
      thumbnailUrl: await storage()
        .getThumbnailUrl(v.id)
        .catch(() => null),
      matchStatus: deriveMatchStatus(v, v),
    })),
  );
}

/** The signed-in user's own editable fields — see `GET /api/users/[id]`. */
export interface Account {
  email: string | null;
  /** The raw stored display name — blank when unset, unlike `profile.displayName`. */
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
export async function loadAccount(userId: string): Promise<Account> {
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

/** Profile summary + account fields for the signed-in user, in one pass. */
export async function loadMe() {
  const { social, userId } = await socialForRequest();
  if (!userId) return { profile: null, account: null };
  const [profile, account] = await Promise.all([
    social.profileSummary(userId),
    loadAccount(userId),
  ]);
  return { profile, account };
}
