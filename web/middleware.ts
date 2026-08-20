import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";
import { VERIFIED_USER_HEADER } from "@/lib/supabase/server";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Files that must be served to clients that will never have a session: search
 * crawlers, the iMessage/WhatsApp/Slack link unfurlers, and the browser fetching
 * the PWA manifest. They were being 307'd to /sign-in, which made robots.txt and
 * sitemap.xml invisible to Google and left every shared match link unfurling as
 * a bare URL.
 *
 * Checked before the Supabase client is built, so these cost no round trip.
 */
const PUBLIC_FILES = new Set([
  "/robots.txt",
  "/sitemap.xml",
  "/manifest.webmanifest",
  "/llms.txt",
  "/opengraph-image", // Next's generated OG card (app/opengraph-image.tsx)
  "/twitter-image",
]);

export async function middleware(request: NextRequest) {
  if (PUBLIC_FILES.has(request.nextUrl.pathname)) return NextResponse.next();

  // No Supabase configured → zero-auth local mode, let everything through.
  if (!appConfig.authEnabled) return NextResponse.next();

  // Native clients (iOS) authenticate with a Bearer token instead of cookies.
  const authHeader = request.headers.get("authorization") ?? undefined;

  // Cookies the session refresh wants to set. Collected here and applied to the
  // final response once, so the response is built in one place (below).
  let refreshedCookies: CookieToSet[] = [];

  const supabase = createServerClient(appConfig.supabase.url, appConfig.supabase.anonKey, {
    ...(authHeader ? { global: { headers: { Authorization: authHeader } } } : {}),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => {
        // Writing to request.cookies also updates the request's `cookie` header,
        // which is what downstream handlers read.
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        refreshedCookies = cookiesToSet;
      },
    },
  });

  // Refreshes the session and tells us who's signed in. Cookies resolve via the
  // session; a Bearer token (iOS) is validated explicitly.
  const token = authHeader?.match(/^Bearer (.+)$/i)?.[1];
  const {
    data: { user },
  } = token ? await supabase.auth.getUser(token) : await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  // /api/cron has no session by definition — it's invoked by Vercel's scheduler,
  // not a browser. It authenticates itself with CRON_SECRET inside the route, so
  // it must reach the route rather than being 401'd here.
  // /privacy and /terms are public because App Store review opens the privacy
  // policy URL before it has an account, and the EULA has to be readable by
  // anyone deciding whether to sign up.
  // /invite is public because an invited player has no account yet — bouncing
  // them to /sign-in with no explanation is the dead end the invite flow exists
  // to fix. The token in the path is the capability, checked by the route.
  const publicPrefixes = [
    "/landing",
    "/sign-in",
    "/sign-up",
    "/login",
    "/auth",
    "/privacy",
    "/terms",
    "/invite",
    "/api/invites",
    "/api/cron",
    // Resend's inbound webhook. Arrives with no session, so it has to be
    // public; the route authenticates it by signature instead.
    "/api/inbound",
  ];
  const isPublic = publicPrefixes.some((p) => path === p || path.startsWith(`${p}/`));

  if (!user && !isPublic) {
    if (path.startsWith("/api")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const redirect = request.nextUrl.clone();
    redirect.search = "";
    if (path === "/") {
      // A fresh visitor to the root sees the marketing landing page.
      redirect.pathname = "/landing";
    } else {
      // Deep links (e.g. a shared /watch/<id>?s=<token>) go via sign-in and
      // return to where they were headed.
      redirect.pathname = "/sign-in";
      redirect.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    }
    return NextResponse.redirect(redirect);
  }

  // Pass the *verified* user id downstream so route handlers and Server
  // Components don't each repeat the round trip to Supabase we just made.
  // The header is deleted unconditionally first — a client must never be able to
  // supply it themselves. See lib/supabase/server.ts.
  const headers = new Headers(request.headers);
  headers.delete(VERIFIED_USER_HEADER);
  if (user) headers.set(VERIFIED_USER_HEADER, user.id);

  const response = NextResponse.next({ request: { headers } });
  for (const { name, value, options } of refreshedCookies) {
    response.cookies.set(name, value, options);
  }
  return response;
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
