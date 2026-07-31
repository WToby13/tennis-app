"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const supabase = getSupabaseBrowser();

    const { data, error } =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // With email confirmation disabled, sign-up returns a live session; otherwise
    // Supabase sends a confirmation email and there's no session yet.
    if (!data.session) {
      setNotice("Account created. Check your email to confirm, then sign in.");
      setMode("signin");
      setBusy(false);
      return;
    }

    router.push("/");
    router.refresh();
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>{mode === "signin" ? "Sign in" : "Create account"}</h1>
      <form onSubmit={onSubmit} className="card" style={{ padding: 24 }}>
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
            minLength={6}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}
        {notice && <p style={{ color: "var(--accent)", fontSize: 14 }}>{notice}</p>}

        <button className="btn" type="submit" disabled={busy || !email || !password}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>

      <p className="muted" style={{ fontSize: 14, marginTop: 16, textAlign: "center" }}>
        {mode === "signin" ? "No account yet?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setNotice(null);
          }}
          style={{
            background: "none",
            border: "none",
            color: "var(--accent)",
            cursor: "pointer",
            padding: 0,
            fontSize: 14,
          }}
        >
          {mode === "signin" ? "Create one" : "Sign in"}
        </button>
      </p>
    </div>
  );
}
