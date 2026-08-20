import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";
import { LocalJsonMetadataStore } from "./localJson";
import { SupabaseMetadataStore } from "./supabase";
import type { MetadataStore } from "./types";

let localStore: MetadataStore | null = null;

/**
 * Metadata store selector.
 * - Supabase (auth) mode: pass the request-scoped client so RLS applies.
 * - Local dev mode: JSON file, no client needed.
 */
export function metadata(
  supabase?: SupabaseClient,
  userId?: string | null,
  /** Set only for the service-role client — see SupabaseMetadataStore. */
  serviceRole = false,
): MetadataStore {
  if (config.authEnabled) {
    if (!supabase) throw new Error("metadata() requires a Supabase client when auth is enabled");
    return new SupabaseMetadataStore(supabase, userId ?? null, serviceRole);
  }
  if (!localStore) localStore = new LocalJsonMetadataStore();
  return localStore;
}

export type {
  InvitePreview,
  LibraryEntry,
  MetadataStore,
  Participant,
  ParticipantInput,
  ParticipantInvite,
  ShareLink,
  UserResult,
  Video,
  VideoStatus,
  VideoVisibility,
} from "./types";
