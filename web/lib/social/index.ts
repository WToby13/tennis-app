import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { LocalSocialStore } from "./local";
import { SupabaseSocialStore } from "./supabase";
import type { SocialStore } from "./types";

let localStore: SocialStore | null = null;

/**
 * Social store selector.
 * - Supabase (auth) mode: pass the request-scoped client + the caller's id.
 * - Local dev mode: single-user store (feed mirrors the local library).
 */
export function social(supabase?: SupabaseClient, userId?: string | null): SocialStore {
  if (config.authEnabled) {
    if (!supabase) throw new Error("social() requires a Supabase client when auth is enabled");
    return new SupabaseSocialStore(supabase, userId ?? null);
  }
  if (!localStore) localStore = new LocalSocialStore();
  return localStore;
}

export type {
  Comment,
  FeedItem,
  LikeState,
  Notification,
  ProfileSummary,
  ReportInput,
  ReportReason,
  SocialStore,
} from "./types";
