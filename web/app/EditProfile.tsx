"use client";

import { useCallback, useState } from "react";
import { CloseIcon } from "./icons";
import { getSupabaseBrowser } from "@/lib/supabase/client";

type Hand = "left" | "right";

export interface AccountFields {
  email: string | null;
  displayName: string;
  firstName: string;
  lastName: string;
  handedness: Hand;
}

/**
 * Account settings, as a modal on the library page — the profile no longer has a
 * page of its own. Writes straight to the `profiles` row (RLS scopes it to the
 * caller), the same way the iOS editor does.
 */
export function EditProfile({
  userId,
  initial,
  onClose,
  onSaved,
}: {
  userId: string;
  initial: AccountFields;
  onClose: () => void;
  onSaved: (fields: AccountFields) => void;
}) {
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [handedness, setHandedness] = useState<Hand>(initial.handedness);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      // Use the entered display name; fall back to first+last only when blank.
      const resolved = displayName.trim() || `${firstName} ${lastName}`.trim();
      const { error } = await getSupabaseBrowser()
        .from("profiles")
        .update({
          first_name: firstName,
          last_name: lastName,
          handedness,
          display_name: resolved,
        })
        .eq("id", userId);
      setSaving(false);
      if (error) {
        setError(error.message);
        return;
      }
      onSaved({
        email: initial.email,
        displayName: resolved,
        firstName,
        lastName,
        handedness,
      });
    },
    [displayName, firstName, lastName, handedness, userId, initial.email, onSaved],
  );

  async function signOut() {
    await getSupabaseBrowser().auth.signOut();
    window.location.href = "/landing";
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ fontSize: 18 }}>Your profile</h2>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </div>

        <form onSubmit={save} style={{ padding: 20 }}>
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

          <div className="modal-actions">
            <button className="btn secondary" type="button" onClick={signOut}>
              Sign out
            </button>
            <button className="btn" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
