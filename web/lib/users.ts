import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServiceRole, serviceRoleConfigured } from "./supabase/service";

/**
 * Email addresses for a handful of user ids.
 *
 * Addresses live in `auth.users`, which PostgREST doesn't expose, so this needs
 * the admin API and therefore the service-role key. Used only to notify people
 * that they were tagged in a match — never to show an address to another user.
 * Returns what it can: a missing key or a failed lookup means no notification,
 * not a failed save.
 */
export async function emailsForUserIds(ids: string[]): Promise<string[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length || !serviceRoleConfigured()) return [];

  const admin = getSupabaseServiceRole();
  const found = await Promise.all(
    unique.map(async (id) => {
      try {
        const { data } = await admin.auth.admin.getUserById(id);
        return data?.user?.email ?? null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((e): e is string => Boolean(e));
}

/** The signed-in user's display name, for "X added you to a match". */
export async function displayNameFor(
  supabase: SupabaseClient,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const { data } = await supabase
    .from("profiles")
    .select("display_name, first_name, last_name")
    .eq("id", userId)
    .maybeSingle();
  if (!data) return null;
  const row = data as { display_name: string | null; first_name: string | null; last_name: string | null };
  return (
    row.display_name?.trim() ||
    [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
    null
  );
}
