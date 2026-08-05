"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "../Avatar";
import { config } from "@/lib/config";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Hand = "left" | "right";

export default function ProfilePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [handedness, setHandedness] = useState<Hand>("right");
  const [counts, setCounts] = useState({ followers: 0, following: 0 });
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
      setMyId(user.id);
      const { data } = await supabase
        .from("profiles")
        .select("display_name, first_name, last_name, handedness")
        .eq("id", user.id)
        .maybeSingle();
      if (data) {
        setDisplayName(data.display_name ?? "");
        setFirstName(data.first_name ?? "");
        setLastName(data.last_name ?? "");
        if (data.handedness === "left" || data.handedness === "right") setHandedness(data.handedness);
      }
      const [{ count: followers }, { count: following }] = await Promise.all([
        supabase.from("follows").select("*", { count: "exact", head: true }).eq("followee_id", user.id),
        supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", user.id),
      ]);
      setCounts({ followers: followers ?? 0, following: following ?? 0 });
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
          // Use the entered display name; fall back to first+last only when blank.
          display_name: displayName.trim() || `${firstName} ${lastName}`.trim(),
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
    [displayName, firstName, lastName, handedness, router],
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

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Avatar name={displayName || `${firstName} ${lastName}`} size={56} />
        <div>
          <h1 style={{ marginBottom: 2 }}>{displayName || "Your profile"}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            <b className="mono">{counts.followers}</b> followers ·{" "}
            <b className="mono">{counts.following}</b> following · {email}
          </p>
        </div>
      </div>
      {myId && (
        <Link
          href={`/u/${myId}`}
          className="btn secondary btn-sm"
          style={{ marginTop: 12, display: "inline-flex" }}
        >
          View public profile
        </Link>
      )}

      <form onSubmit={save} className="card" style={{ padding: 24, marginTop: 18 }}>
        <label className="field">
          <span className="lbl">Display name</span>
          <input
            type="text"
            placeholder="Shown on your matches, feed and comments"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={saving}
          />
        </label>

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
