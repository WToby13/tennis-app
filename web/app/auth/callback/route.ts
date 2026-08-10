import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Same-site absolute paths only — the destination is client-supplied. */
function safePath(value: string | undefined | null): string | null {
  if (!value) return null;
  const decoded = decodeURIComponent(value);
  return decoded.startsWith("/") && !decoded.startsWith("//") ? decoded : null;
}

/**
 * Magic-link / OAuth landing route. Supabase redirects here with a `code`; we
 * exchange it for a session (cookies are set via the server client) and send the
 * user in.
 *
 * The destination comes from the `ojo_next` cookie that GoogleButton sets before
 * starting the flow, rather than a `?next=` on this URL — see the comment there
 * for why the redirect URL has to stay constant. `?next=` is still honoured as a
 * fallback for any link built the old way.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next =
    safePath(searchParams.get("next")) ??
    safePath(request.cookies.get("ojo_next")?.value) ??
    "/";

  if (code) {
    const supabase = await getSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Google can't tell us the playing hand — send first-time OAuth users to
      // finish their profile before dropping them into the app.
      const {
        data: { user },
      } = await supabase.auth.getUser();
      let dest = next;
      if (user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("handedness")
          .eq("id", user.id)
          .maybeSingle();
        if (!profile?.handedness) dest = "/profile";
      }
      return done(`${origin}${dest}`);
    }
  }

  return done(`${origin}/sign-in?error=auth`);
}

/** Redirect onward, clearing the one-shot destination cookie either way. */
function done(url: string) {
  const response = NextResponse.redirect(url);
  response.cookies.set("ojo_next", "", { maxAge: 0, path: "/" });
  return response;
}
