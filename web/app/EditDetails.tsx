"use client";

import { useEffect, useRef, useState } from "react";

export interface EditableParticipant {
  userId: string | null;
  displayName: string;
  email: string | null;
}

interface Props {
  videoId: string;
  initialTitle: string;
  initialParticipants: EditableParticipant[];
  onSaved: (title: string, participants: EditableParticipant[]) => void;
  onCancel: () => void;
  /** Render without the outer card (e.g. when already inside a modal). */
  bare?: boolean;
}

/** Owner editor for a match's title + participants (search users, add guests). */
export function EditDetails({ videoId, initialTitle, initialParticipants, onSaved, onCancel, bare }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [list, setList] = useState<EditableParticipant[]>(initialParticipants);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; displayName: string }[]>([]);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Search Ojo users as you type (min 2 chars), lightly debounced.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(query.trim())}`);
        if (res.ok) setResults((await res.json()).users ?? []);
      } catch {
        /* ignore search errors */
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  function addUser(u: { id: string; displayName: string }) {
    if (list.some((p) => p.userId === u.id)) return;
    setList([...list, { userId: u.id, displayName: u.displayName, email: null }]);
    setQuery("");
    setResults([]);
  }

  function addGuest() {
    const name = guestName.trim();
    if (!name) return;
    setList([...list, { userId: null, displayName: name, email: guestEmail.trim() || null }]);
    setGuestName("");
    setGuestEmail("");
  }

  function remove(i: number) {
    setList(list.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const t = title.trim();
      if (t && t !== initialTitle) {
        await fetch(`/api/videos/${videoId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: t }),
        });
      }
      const res = await fetch(`/api/videos/${videoId}/participants`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ participants: list }),
      });
      if (!res.ok) throw new Error("Couldn't save participants");
      onSaved(t || initialTitle, list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <div className={bare ? "" : "card"} style={bare ? undefined : { padding: 20, marginTop: 16 }}>
      <label className="field">
        <span className="lbl">Match name</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
      </label>

      <div className="field">
        <span className="lbl">Players</span>
        {list.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
            {list.map((p, i) => (
              <span
                key={`${p.userId ?? "guest"}-${i}`}
                className="chip"
                style={{ background: "var(--surface-2)", display: "inline-flex", gap: 8 }}
              >
                {p.displayName}
                {p.userId === null && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {p.email ? "invited" : "guest"}
                  </span>
                )}
                <button
                  onClick={() => remove(i)}
                  style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0 }}
                  aria-label={`Remove ${p.displayName}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          type="text"
          placeholder="Search Ojo players by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={saving}
        />
        {results.length > 0 && (
          <div className="card" style={{ marginTop: 6 }}>
            {results.map((u) => (
              <button
                key={u.id}
                onClick={() => addUser(u)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  color: "var(--text)",
                  padding: "10px 12px",
                  cursor: "pointer",
                }}
              >
                {u.displayName}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="field">
        <span className="lbl">Add someone not on Ojo</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            placeholder="Name"
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            disabled={saving}
          />
          <input
            type="email"
            placeholder="Email (optional — to invite)"
            value={guestEmail}
            onChange={(e) => setGuestEmail(e.target.value)}
            disabled={saving}
          />
          <button className="btn secondary" type="button" onClick={addGuest} disabled={saving || !guestName.trim()}>
            Add
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          With an email, they’ll be linked to this match automatically when they sign up.
        </p>
      </div>

      {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}
