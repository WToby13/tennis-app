"use client";

import { useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

/** Only allow same-site absolute paths as the post-auth destination. */
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * "Continue with Google" — starts the Supabase OAuth flow, returns via /auth/callback.
 *
 * The post-auth destination rides in a short-lived cookie rather than a `?next=`
 * on the redirect URL. Supabase matches its redirect allow-list against the FULL
 * url including the query string, so a query param means every destination needs
 * its own allow-list entry (or a wildcard) — and when it doesn't match, GoTrue
 * silently falls back to the project's Site URL instead of erroring. Keeping the
 * redirect URL constant makes one exact allow-list entry always correct.
 * SameSite=Lax so the cookie survives the top-level redirect back from Google.
 */
export function GoogleButton() {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    document.cookie = `ojo_next=${encodeURIComponent(safeNext())}; Max-Age=600; Path=/; SameSite=Lax`;
    const { error } = await getSupabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) setBusy(false); // otherwise the browser navigates away to Google
  }
  return (
    <button
      type="button"
      className="btn secondary"
      style={{ width: "100%", justifyContent: "center" }}
      onClick={go}
      disabled={busy}
    >
      <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
        <path fill="#4285F4" d="M17.6 9.2c0-.6-.05-1.2-.15-1.7H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.6z" />
        <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z" />
        <path fill="#FBBC05" d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8l3-2.3z" />
        <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
      </svg>
      {busy ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}

/** A small "or" divider between OAuth and the email form. */
export function OrDivider() {
  return (
    <div
      className="muted"
      style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0", fontSize: 12 }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
      OR
      <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
    </div>
  );
}
