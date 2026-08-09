import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { config } from "../config";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Extract a JWT from an `Authorization: Bearer <jwt>` header, if present. */
function bearerToken(authHeader: string | undefined): string | undefined {
  return authHeader?.match(/^Bearer (.+)$/i)?.[1];
}

/**
 * Request-scoped Supabase client for Server Components and Route Handlers.
 *
 * The web app carries its session in cookies. Native clients (the iOS app) send
 * `Authorization: Bearer <jwt>` instead — when that header is present we attach it
 * to the client so both `auth.getUser()` and RLS-scoped queries use the caller's
 * token. Either way the request runs as the right user.
 */
export async function getSupabaseServer() {
  const cookieStore = await cookies();
  const authHeader = (await headers()).get("authorization") ?? undefined;

  return createServerClient(config.supabase.url, config.supabase.anonKey, {
    ...(authHeader ? { global: { headers: { Authorization: authHeader } } } : {}),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component where cookies are read-only — safe to
          // ignore; the middleware refreshes the session cookie instead.
        }
      },
    },
  });
}

/**
 * Header carrying the user id the middleware already verified for this request.
 *
 * Trustworthy only because the middleware deletes any inbound copy before
 * setting its own (see middleware.ts) — never read it anywhere the middleware
 * hasn't run.
 */
export const VERIFIED_USER_HEADER = "x-ojo-user-id";

/**
 * Resolve the current user id for a request.
 *
 * The middleware has already validated the session (cookies for web, a Bearer
 * token for iOS) on the way in and passed the result along, so the common path
 * is a header read rather than a second network round trip to Supabase. The
 * `auth.getUser()` fallback covers requests the middleware didn't handle.
 */
export async function getRequestUserId(supabase: SupabaseClient): Promise<string | null> {
  const requestHeaders = await headers();

  const verified = requestHeaders.get(VERIFIED_USER_HEADER);
  if (verified) return verified;

  const token = bearerToken(requestHeaders.get("authorization") ?? undefined);
  const {
    data: { user },
  } = token ? await supabase.auth.getUser(token) : await supabase.auth.getUser();
  return user?.id ?? null;
}
