"use client";

import { useEffect, useRef, useState } from "react";

/** Matches the `reason` values the API accepts. */
const REASONS: Array<{ value: string; label: string }> = [
  { value: "abuse", label: "Harassment or hate" },
  { value: "sexual", label: "Nudity or sexual content" },
  { value: "violence", label: "Violence or self-harm" },
  { value: "spam", label: "Spam or a scam" },
  { value: "other", label: "Something else" },
];

export interface ModerationTarget {
  kind: "match" | "comment";
  /** Match id, or comment id. */
  id: string;
  /** The match a reported comment sits on — the API needs it to find the row. */
  videoId?: string;
  authorId: string | null;
  authorName: string | null;
}

/**
 * "Report" / "Block" for content that isn't yours — the web counterpart of the
 * iOS `ModerationMenu`. Renders nothing when the content is the viewer's own.
 *
 * Both actions exist because App Store Review Guideline 1.2 requires them on
 * the app, and the two clients share one backend: a block made on the phone has
 * to be visible and reversible here, and vice versa.
 */
export function ModerationMenu({
  target,
  isMine = false,
  onBlocked,
}: {
  target: ModerationTarget;
  isMine?: boolean;
  onBlocked?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Click-away, so the menu doesn't sit open behind whatever you click next.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (isMine) return null;

  async function block() {
    setOpen(false);
    if (!target.authorId) return;
    if (!window.confirm(`Block ${target.authorName ?? "this player"}? You won't see their matches or comments, and they won't see yours.`)) {
      return;
    }
    const res = await fetch(`/api/users/${target.authorId}/block`, { method: "POST" }).catch(() => null);
    if (res?.ok) onBlocked?.();
  }

  return (
    <div className="mod-menu" ref={wrap}>
      <button
        type="button"
        className="mod-trigger"
        aria-label="More options"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="mod-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setReporting(true);
            }}
          >
            Report
          </button>
          {target.authorId && (
            <button type="button" role="menuitem" className="danger" onClick={block}>
              Block {target.authorName ?? "this player"}
            </button>
          )}
        </div>
      )}
      {reporting && <ReportModal target={target} onClose={() => setReporting(false)} />}
    </div>
  );
}

function ReportModal({ target, onClose }: { target: ModerationTarget; onClose: () => void }) {
  const [reason, setReason] = useState(REASONS[0].value);
  const [details, setDetails] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    const res = await fetch("/api/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetKind: target.kind,
        targetId: target.id,
        videoId: target.videoId,
        reason,
        details: details.trim() || undefined,
      }),
    }).catch(() => null);
    setSending(false);
    if (res?.ok) setSent(true);
    else setError("Couldn't send that. Try again in a moment.");
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 style={{ fontSize: 18 }}>Report this {target.kind}</h2>
        </div>
        {sent ? (
          <div style={{ padding: 20 }}>
            <p style={{ margin: 0, fontSize: 14 }}>Report sent.</p>
            <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
              We review every report within 24 hours and remove anything that breaks our rules.
            </p>
            <div className="modal-actions">
              <button className="btn" type="button" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={send} style={{ padding: 20 }}>
            <label className="field">
              <span className="lbl">What&rsquo;s wrong with it?</span>
              <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={sending}>
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="lbl">Anything else? (optional)</span>
              <textarea
                rows={3}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                disabled={sending}
              />
            </label>
            {error && <p style={{ color: "var(--danger)", fontSize: 14 }}>{error}</p>}
            <div className="modal-actions">
              <button className="btn secondary" type="button" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button className="btn" type="submit" disabled={sending}>
                {sending ? "Sending…" : "Send report"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
