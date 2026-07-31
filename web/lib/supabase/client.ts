"use client";

import { createBrowserClient } from "@supabase/ssr";
import { config } from "../config";

/** Supabase client for Client Components (login form, logout button). */
export function getSupabaseBrowser() {
  return createBrowserClient(config.supabase.url, config.supabase.anonKey);
}
