"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { GoogleButton, OrDivider } from "../GoogleButton";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Hand = "left" | "right";

function nextTarget(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export default function SignUpPage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [handedness, setHandedness] = useState<Hand>("right");
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

    const displayName = `${firstName} ${lastName}`.trim();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // Read by the handle_new_user trigger to populate the profile row.
      options: { data: { first_name: firstName, last_name: lastName, handedness, display_name: displayName } },
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // Email confirmation disabled → we get a live session. Otherwise there's no
    // session yet and the profile fills in from metadata on first sign-in.
    if (!data.session) {
      setNotice("Account created. Check your email to confirm, then sign in.");
      setBusy(false);
      return;
    }

    // Belt-and-suspenders: ensure the profile carries the details even if the
    // trigger hasn't been updated yet (RLS allows managing your own row).
    if (data.user) {
      await supabase
        .from("profiles")
        .upsert({
          id: data.user.id,
          first_name: firstName,
          last_name: lastName,
          handedness,
          display_name: displayName,
        })
        .then(() => {}, () => {});
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
      <h1 style={{ textAlign: "center" }}>Create account</h1>
      <div className="card" style={{ padding: 24, marginTop: 16 }}>
        <GoogleButton />
        <OrDivider />
        <form onSubmit={onSubmit}>
        <div style={{ display: "flex", gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span className="lbl">First name</span>
            <input
              type="text"
              required
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span className="lbl">Last name</span>
            <input
              type="text"
              required
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={busy}
            />
          </label>
        </div>

        <div className="field">
          <span className="lbl">Playing hand</span>
          <div className="segmented">
            {(["left", "right"] as Hand[]).map((h) => (
              <label key={h} className={handedness === h ? "on" : ""}>
                <input
                  type="radio"
                  name="handedness"
                  value={h}
                  checked={handedness === h}
                  onChange={() => setHandedness(h)}
                  disabled={busy}
                />
                {h === "left" ? "Left-handed" : "Right-handed"}
              </label>
            ))}
          </div>
        </div>

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
            autoComplete="new-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}
        {notice && <p style={{ color: "var(--accent)", fontSize: 14 }}>{notice}</p>}

        <button
          className="btn"
          type="submit"
          disabled={busy || !firstName || !lastName || !email || !password}
        >
          {busy ? "…" : "Create account"}
        </button>
        </form>
      </div>

      <p className="auth-alt muted">
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>
    </div>
  );
}
