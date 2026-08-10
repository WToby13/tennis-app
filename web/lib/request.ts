import { config } from "./config";
import { metadata } from "./metadata";
import type { MetadataStore } from "./metadata";
import { social } from "./social";
import type { SocialStore } from "./social";
import { getRequestUserId, getSupabaseServer } from "./supabase/server";

/**
 * Resolve the metadata store and current user for an API request.
 *
 * In auth mode the store is bound to the caller's Supabase session (RLS applies)
 * and `userId` is their id. In local mode there's no user and the JSON store is used.
 * Middleware already 401s unauthenticated /api calls, so `userId` is only null here
 * in local mode.
 */
export async function storeForRequest(): Promise<{ store: MetadataStore; userId: string | null }> {
  if (!config.authEnabled) return { store: metadata(), userId: null };

  const supabase = await getSupabaseServer();
  const userId = await getRequestUserId(supabase);
  return { store: metadata(supabase, userId), userId };
}

/** Like storeForRequest, but for the social store (feed, follows, likes, comments). */
export async function socialForRequest(): Promise<{ social: SocialStore; userId: string | null }> {
  if (!config.authEnabled) return { social: social(), userId: null };

  const supabase = await getSupabaseServer();
  const userId = await getRequestUserId(supabase);
  return { social: social(supabase, userId), userId };
}
