"use client";

import { useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const supabase = getSupabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    } else {
      setSent(true);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "40px auto" }}>
      <h1>Sign in</h1>
      {sent ? (
        <div className="card" style={{ padding: 24 }}>
          <p style={{ fontSize: 32, margin: 0 }}>📬</p>
          <p>
            Check <b>{email}</b> for a magic link. Open it on this device to sign in.
          </p>
          <button className="btn secondary" onClick={() => setSent(false)}>
            Use a different email
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="card" style={{ padding: 24 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Enter your email and we'll send you a one-click sign-in link.
          </p>
          <label className="field">
            <span className="lbl">Email</span>
            <input
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}
          <button className="btn" type="submit" disabled={busy || !email}>
            {busy ? "Sending…" : "Send magic link"}
          </button>
        </form>
      )}
    </div>
  );
}
