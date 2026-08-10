import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

/**
 * A Supabase client holding the service-role key — no user, no RLS.
 *
 * Only for work that legitimately has no signed-in caller: today that's the cron
 * sweep that advances analyses so a run doesn't depend on someone having a page
 * open. Never hand this to anything that serves a user request; every other path
 * must stay RLS-scoped so a user can only ever touch their own rows.
 *
 * Note it also has no `auth.uid()`, so security-definer RPCs that gate on edit
 * rights will refuse — see `SupabaseMetadataStore.replaceSegments`.
 */
export function getSupabaseServiceRole(): SupabaseClient {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(config.supabase.url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
