import { getSupabaseServer } from "../supabase/server";

/**
 * Who is allowed into /admin.
 *
 * An email in an environment variable rather than a role column, because there
 * is exactly one operator and a `profiles.is_admin` flag would be a row anyone
 * with a database connection could flip. An env var can only be changed by
 * whoever controls the deployment, which is the property that matters.
 *
 * Unset means **nobody** — not "everybody". A missing variable is the normal
 * state of a fresh environment (a preview deploy, a new machine, a fork), and
 * the safe reading of it is that the dashboard does not exist there.
 */
export function adminEmail(): string | null {
  const raw = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  return raw ? raw : null;
}

/**
 * The signed-in admin's email, or null for everyone else.
 *
 * Compares against the address on the *session*, read server-side from Supabase
 * — never a value from the client, and never the `profiles` row, whose
 * `display_name` a user can edit. Case-insensitive because email addresses are
 * not case-sensitive in practice and a capitalised sign-up would otherwise lock
 * the operator out of their own dashboard.
 *
 * Every admin surface calls this for itself. The layout gate hides the UI, but
 * a hidden page is not a protected one: each route handler re-checks, so a
 * hand-crafted request to `/api/admin/...` is refused on its own merits.
 */
export async function currentAdmin(): Promise<string | null> {
  const allowed = adminEmail();
  if (!allowed) return null;

  const supabase = await getSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email?.trim().toLowerCase();

  return email && email === allowed ? email : null;
}
