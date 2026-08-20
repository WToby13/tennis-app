"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GoogleButton, OrDivider } from "../GoogleButton";
import { friendlyAuthError } from "@/lib/authErrors";
import { getSupabaseBrowser } from "@/lib/supabase/client";

/** Where to go after auth: the `?next=` path if it's a safe in-app path, else home. */
function nextTarget(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** Prefill from an invite link, so a returning player doesn't retype it. */
function invitedEmail(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("email") ?? "";
}

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      setError(friendlyAuthError(error.message));
      setBusy(false);
      return;
    }
    router.push(nextTarget());
    router.refresh();
  }

  return (
    <div className="auth-wrap">
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Ojo Tennis" width={60} height={60} style={{ borderRadius: 14 }} />
      </div>
      <h1 style={{ textAlign: "center" }}>Sign in</h1>
      <div className="card" style={{ padding: 24, marginTop: 16 }}>
        <GoogleButton />
        <OrDivider />
        <form onSubmit={onSubmit}>
          <label className="field">
            <span className="lbl">Email</span>
            <input
              type="email"
              required
              autoFocus
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field">
            <span className="lbl">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </label>

          {error && (
            <p role="alert" style={{ color: "var(--danger)", fontSize: 14 }}>
              {error}
            </p>
          )}

          <button className="btn" type="submit" disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>

      <p className="auth-alt muted">
        No account yet?{" "}
        <Link href="/sign-up">Create one</Link>
      </p>
    </div>
  );
}
