"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { config } from "@/lib/config";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Hand = "left" | "right";

export default function ProfilePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [handedness, setHandedness] = useState<Hand>("right");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config.authEnabled) {
      setLoading(false);
      return;
    }
    (async () => {
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/sign-in?next=/profile");
        return;
      }
      setEmail(user.email ?? null);
      const { data } = await supabase
        .from("profiles")
        .select("first_name, last_name, handedness")
        .eq("id", user.id)
        .maybeSingle();
      if (data) {
        setFirstName(data.first_name ?? "");
        setLastName(data.last_name ?? "");
        if (data.handedness === "left" || data.handedness === "right") setHandedness(data.handedness);
      }
      setLoading(false);
    })();
  }, [router]);

  const save = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      setSaved(false);
      const supabase = getSupabaseBrowser();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        router.push("/sign-in?next=/profile");
        return;
      }
      const { error } = await supabase
        .from("profiles")
        .update({
          first_name: firstName,
          last_name: lastName,
          handedness,
          display_name: `${firstName} ${lastName}`.trim(),
        })
        .eq("id", user.id);
      setSaving(false);
      if (error) {
        setError(error.message);
        return;
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    },
    [firstName, lastName, handedness, router],
  );

  async function signOut() {
    await getSupabaseBrowser().auth.signOut();
    router.push("/landing");
    router.refresh();
  }

  if (!config.authEnabled) {
    return (
      <div style={{ maxWidth: 480 }}>
        <h1>Profile</h1>
        <p className="muted">Profiles are available once Supabase auth is configured.</p>
      </div>
    );
  }

  if (loading) return <p className="muted">Loading…</p>;

  return (
    <div style={{ maxWidth: 480 }}>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        Account
      </div>
      <h1 style={{ marginBottom: 6 }}>Profile</h1>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {email}
      </p>

      <form onSubmit={save} className="card" style={{ padding: 24, marginTop: 18 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            <span className="lbl">First name</span>
            <input
              type="text"
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span className="lbl">Last name</span>
            <input
              type="text"
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={saving}
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
                  disabled={saving}
                />
                {h === "left" ? "Left-handed" : "Right-handed"}
              </label>
            ))}
          </div>
        </div>

        {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}

        <button className="btn" type="submit" disabled={saving}>
          {saving ? "Saving…" : saved ? "✓ Saved" : "Save changes"}
        </button>
      </form>

      <button className="btn secondary" style={{ marginTop: 18 }} onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
