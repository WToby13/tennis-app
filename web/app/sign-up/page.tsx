"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { GoogleButton, OrDivider } from "../GoogleButton";
import { track } from "@/lib/analytics/client";
import { friendlyAuthError } from "@/lib/authErrors";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Hand = "left" | "right";

function nextTarget(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * The address an invite was sent to, prefilled so the common case is one less
 * thing to type. It is only a convenience: the invite is claimed by its token,
 * so signing up with a different address (or with Google) still works.
 */
function invitedEmail(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("email") ?? "";
}

export default function SignUpPage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [handedness, setHandedness] = useState<Hand>("right");
  const [email, setEmail] = useState(invitedEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Where the form was reached from separates the two funnels that matter: a
  // recipient arriving off a share link or an invite, versus someone who found
  // the landing page. They convert very differently and the difference is the
  // whole argument in docs/GTM.md §2.
  useEffect(() => {
    const next = new URLSearchParams(window.location.search).get("next") ?? "";
    const from = next.startsWith("/watch/")
      ? "share_link"
      : next.startsWith("/invite/")
        ? "invite"
        : "direct";
    track("signup_started", { from });
  }, []);

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
      setError(friendlyAuthError(error.message));
      setBusy(false);
      return;
    }

    // Email confirmation disabled → we get a live session. Otherwise there's no
    // session yet and the profile fills in from metadata on first sign-in.
    if (!data.session) {
      // The account exists; it just can't be used until the email is confirmed.
      // Counted as a signup either way, or the conversion numbers would depend
      // on a Supabase setting rather than on anything a person did.
      track("signup_completed", { method: "password", confirmationPending: true }, { now: true });
      setNotice("Account created. Check your email to confirm, then sign in.");
      setBusy(false);
      return;
    }

    track("signup_completed", { method: "password", confirmationPending: false }, { now: true });

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
              autoFocus
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
            minLength={6}
            autoComplete="new-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>

        {error && <p role="alert" style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}
        {notice && <p style={{ color: "var(--accent)", fontSize: 14 }}>{notice}</p>}

        <button
          className="btn"
          type="submit"
          disabled={busy || !firstName || !lastName || !email || !password}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
        </form>
      </div>

      <p className="auth-alt muted">
        Already have an account? <Link href="/sign-in">Sign in</Link>
      </p>

      {/* Guideline 1.2 wants the EULA in front of someone before registering or
          logging in — both, not only at sign-up. */}
      <p className="muted" style={{ fontSize: 12, textAlign: "center", marginTop: 4 }}>
        By creating an account you agree to our <Link href="/terms">Terms</Link> and{" "}
        <Link href="/privacy">Privacy Policy</Link>. We remove objectionable content and the
        accounts that post it.
      </p>
    </div>
  );
}
