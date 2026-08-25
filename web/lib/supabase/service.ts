import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

/**
 * A Supabase client holding the service-role key — no user, no RLS.
 *
 * Only for work that legitimately has no signed-in caller. Two things qualify:
 * the cron sweep that advances analyses so a run doesn't depend on someone
 * having a page open, and writing product events (lib/analytics/server.ts) — the
 * `events` table has RLS on with no policies, so nothing else can write to it,
 * and the events that matter most come from visitors with no account at all.
 * Never hand this to anything that serves a user request otherwise; every other
 * path must stay RLS-scoped so a user can only ever touch their own rows.
 *
 * Note it also has no `auth.uid()`, so security-definer RPCs that gate on edit
 * rights will refuse — see `SupabaseMetadataStore.replaceSegments`.
 */
/**
 * Whether the service-role key is available. Worth checking before use: until the
 * cron sweep existed, nothing deployed read this variable — only a local script —
 * so it is easy for an environment to be missing it entirely. Analytics checks
 * this too and quietly collects nothing when it's absent, which is a very easy
 * thing not to notice; see docs/ANALYTICS.md §7.
 */
export function serviceRoleConfigured(): boolean {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseServiceRole(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(config.supabase.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
