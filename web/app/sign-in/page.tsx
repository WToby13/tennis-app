"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

/** Where to go after auth: the `?next=` path if it's a safe in-app path, else home. */
function nextTarget(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
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
      <form onSubmit={onSubmit} className="card" style={{ padding: 24, marginTop: 16 }}>
        <label className="field">
          <span className="lbl">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
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

        {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}

        <button className="btn" type="submit" disabled={busy || !email || !password}>
          {busy ? "…" : "Sign in"}
        </button>
      </form>

      <p className="auth-alt muted">
        No account yet?{" "}
        <Link href="/sign-up">Create one</Link>
      </p>
    </div>
  );
}
