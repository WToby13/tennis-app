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
 * Resolve the current user for a request. Cookies (web) resolve via the session;
 * a Bearer token (iOS) must be passed to `getUser(token)` explicitly, since the
 * no-arg form only looks at the cookie session.
 */
export async function getRequestUser(supabase: SupabaseClient) {
  const token = bearerToken((await headers()).get("authorization") ?? undefined);
  const {
    data: { user },
  } = token ? await supabase.auth.getUser(token) : await supabase.auth.getUser();
  return user;
}

/** The signed-in user, or null. */
export async function getUser() {
  if (!config.authEnabled) return null;
  const supabase = await getSupabaseServer();
  return getRequestUser(supabase);
}
