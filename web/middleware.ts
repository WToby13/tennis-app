import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { config as appConfig } from "@/lib/config";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

export async function middleware(request: NextRequest) {
  // No Supabase configured → zero-auth local mode, let everything through.
  if (!appConfig.authEnabled) return NextResponse.next();

  let response = NextResponse.next({ request });

  // Native clients (iOS) authenticate with a Bearer token instead of cookies.
  const authHeader = request.headers.get("authorization") ?? undefined;

  const supabase = createServerClient(appConfig.supabase.url, appConfig.supabase.anonKey, {
    ...(authHeader ? { global: { headers: { Authorization: authHeader } } } : {}),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: CookieToSet[]) => {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
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
  const isPublic = path.startsWith("/login") || path.startsWith("/auth");

  if (!user && !isPublic) {
    if (path.startsWith("/api")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Bounce to login, remembering where they were headed (e.g. a shared
    // /watch/<id>?s=<token> link) so we can return them there after sign-in.
    const redirect = request.nextUrl.clone();
    const next = request.nextUrl.pathname + request.nextUrl.search;
    redirect.pathname = "/login";
    redirect.search = "";
    redirect.searchParams.set("next", next);
    return NextResponse.redirect(redirect);
  }

  return response;
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
