"use client";

import { useEffect, useRef, useState } from "react";

export interface EditableParticipant {
  userId: string | null;
  displayName: string;
  email: string | null;
}

/** A player still to join, and the link that gets them in. */
interface PendingInvite {
  email: string;
  url: string;
  failed: boolean;
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

/** Good enough to decide whether something is an address; the server validates. */
function looksLikeEmail(text: string): boolean {
  const t = text.trim();
  if (t.includes(" ") || t.length < 5) return false;
  const [local, domain, ...rest] = t.split("@");
  return Boolean(local && domain && !rest.length && domain.includes(".") && !domain.endsWith("."));
}

/**
 * A readable name from an address: "guillem.torner@x.com" → "Guillem Torner".
 *
 * A placeholder until they join, at which point their real profile name replaces
 * it. The old version showed the bare local part ("guillem.torner"), which read
 * as neither a name nor an address — the inviter couldn't tell who had actually
 * been invited, or to what address.
 */
export function nameFromEmail(email: string): string {
  return (
    email
      .split("@")[0]
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || email
  );
}

/** Owner/participant editor for a match's title and players. */
export function EditDetails({ videoId, initialTitle, initialParticipants, onSaved, onCancel, bare }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [list, setList] = useState<EditableParticipant[]>(initialParticipants);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; displayName: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const typed = query.trim();
  const isEmail = looksLikeEmail(typed);
  const taken = (name: string) =>
    list.some((p) => p.displayName.trim().toLowerCase() === name.trim().toLowerCase());

  // Search Ojo users as you type (min 2 chars), lightly debounced. An address
  // isn't a name, so don't search for one.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (typed.length < 2 || looksLikeEmail(typed)) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(typed)}`);
        if (res.ok) setResults((await res.json()).users ?? []);
      } catch {
        /* ignore search errors */
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [typed]);

  // Pending invites already on the match, so their links can be copied even when
  // this session didn't create them.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/videos/${videoId}/invites`);
        if (res.ok && !cancelled) setInvites((await res.json()).invites ?? []);
      } catch {
        /* invites are a convenience; failing to list them isn't an error */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  function add(p: EditableParticipant) {
    setList([...list, p]);
    setQuery("");
    setResults([]);
  }

  function remove(i: number) {
    setList(list.filter((_, idx) => idx !== i));
  }

  async function copy(url: string, key: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      window.prompt("Copy this invite link:", url);
    }
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
      const data = await res.json();
      // The server resolves an address that already belongs to an account into
      // that account, so take its list back rather than trusting ours.
      const saved: EditableParticipant[] = (data.participants ?? list).map(
        (p: EditableParticipant) => ({
          userId: p.userId,
          displayName: p.displayName,
          email: p.email,
        }),
      );
      setList(saved);
      setInvites(data.invites ?? []);

      // If a send failed, stay open so the link can be copied instead — closing
      // here is how an invite silently goes nowhere.
      if ((data.invites ?? []).some((i: PendingInvite) => i.failed)) {
        setSaving(false);
        return;
      }
      onSaved(t || initialTitle, saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  const failed = invites.filter((i) => i.failed);

  return (
    <div className={bare ? "" : "card"} style={bare ? undefined : { padding: 20, marginTop: 16 }}>
      <label className="field">
        <span className="lbl">Match name</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
      </label>

      <div className="field">
        <span className="lbl">Players</span>
        {list.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
            {list.map((p, i) => (
              <div
                key={`${p.userId ?? p.email ?? "guest"}-${i}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "var(--surface-2)",
                  borderRadius: 8,
                  padding: "8px 10px",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14 }}>{p.displayName}</div>
                  {/* Show the address, so the inviter can see exactly who this is */}
                  {p.email && (
                    <div className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
                      {p.email}
                    </div>
                  )}
                </div>
                <span className="muted" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                  {p.userId ? "On Ojo" : p.email ? "Invited" : "Guest"}
                </span>
                <button
                  onClick={() => remove(i)}
                  style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0 }}
                  aria-label={`Remove ${p.displayName}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        {/* One field for all three ways to name someone — a player already on
            Ojo, an address to invite, or just a name. Mirrors the recorder. */}
        <div style={{ position: "relative" }}>
          <input
            type="text"
            placeholder="Search players, or type an email to invite…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={saving}
          />
          {(results.length > 0 || (typed.length > 1 && !taken(typed))) && (
            <div className="search-pop">
              {results
                .filter((u) => !list.some((p) => p.userId === u.id))
                .map((u) => (
                  <button
                    key={u.id}
                    className="search-pop-item"
                    onClick={() => add({ userId: u.id, displayName: u.displayName, email: null })}
                  >
                    {u.displayName} <span className="muted">· On Ojo</span>
                  </button>
                ))}
              {isEmail && !list.some((p) => p.email === typed.toLowerCase()) && (
                <button
                  className="search-pop-item"
                  onClick={() =>
                    add({
                      userId: null,
                      displayName: nameFromEmail(typed),
                      email: typed.toLowerCase(),
                    })
                  }
                >
                  {typed} <span className="muted">· Invite by email</span>
                </button>
              )}
              {!isEmail && typed.length > 1 && !taken(typed) && (
                <button
                  className="search-pop-item"
                  onClick={() => add({ userId: null, displayName: typed, email: null })}
                >
                  {typed} <span className="muted">· Add as guest</span>
                </button>
              )}
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Players on Ojo get the match in their library. Anyone invited by email gets a link to
          join.
        </p>
      </div>

      {failed.length > 0 && (
        <p style={{ color: "var(--danger)", fontSize: 13 }}>
          Couldn&apos;t email {failed.map((i) => i.email).join(", ")}. Send them the invite link
          below instead — it works the same way.
        </p>
      )}

      {invites.length > 0 && (
        <div className="field">
          <span className="lbl">Invite links</span>
          {invites.map((i) => (
            <div
              key={i.email}
              style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}
            >
              <span className="muted" style={{ flex: 1, fontSize: 13, wordBreak: "break-all" }}>
                {i.email}
              </span>
              <button
                type="button"
                className="btn secondary btn-sm"
                onClick={() => copy(i.url, i.email)}
              >
                {copied === i.email ? "Copied" : "Copy link"}
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button className="btn" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {/* After a failed send the panel stays open so the link can be copied —
            but the save itself already went through, so closing must commit it
            rather than look like a cancel. */}
        <button
          className="btn secondary"
          onClick={() => (failed.length > 0 ? onSaved(title.trim() || initialTitle, list) : onCancel())}
          disabled={saving}
        >
          {failed.length > 0 ? "Done" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
