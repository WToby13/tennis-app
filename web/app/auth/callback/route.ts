import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Magic-link landing route. Supabase redirects here with a `code`; we exchange
 * it for a session (cookies are set via the server client) and send the user in.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

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
      return NextResponse.redirect(`${origin}${dest}`);
    }
  }

  return NextResponse.redirect(`${origin}/sign-in?error=auth`);
}
