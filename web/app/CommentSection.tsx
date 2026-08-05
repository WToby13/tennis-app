"use client";

import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";

interface CommentT {
  id: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  canDelete: boolean;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Match-level comments: composer + list, below the video. */
export function CommentSection({ videoId }: { videoId: string }) {
  const [comments, setComments] = useState<CommentT[] | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/videos/${videoId}/comments`)
      .then((r) => r.json())
      .then((d) => setComments(d.comments ?? []))
      .catch(() => setComments([]));
  }, [videoId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (res.ok) {
        setComments((await res.json()).comments ?? []);
        setBody("");
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setComments((c) => (c ?? []).filter((x) => x.id !== id));
    await fetch(`/api/videos/${videoId}/comments/${id}`, { method: "DELETE" }).catch(() => {});
  }

  return (
    <div className="comments">
      <h3 style={{ fontSize: 15, marginBottom: 12 }}>
        Comments{comments ? ` (${comments.length})` : ""}
      </h3>

      <form onSubmit={submit} className="comment-form">
        <input
          type="text"
          placeholder="Add a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
        <button className="btn" type="submit" disabled={busy || !body.trim()}>
          Post
        </button>
      </form>

      {comments?.map((c) => (
        <div key={c.id} className="comment">
          <Avatar name={c.authorName} size={30} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <b>{c.authorName}</b>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                {timeAgo(c.createdAt)}
              </span>
            </div>
            <div style={{ fontSize: 14, marginTop: 2, wordBreak: "break-word" }}>{c.body}</div>
          </div>
          {c.canDelete && (
            <button className="comment-del" onClick={() => remove(c.id)} aria-label="Delete comment">
              ×
            </button>
          )}
        </div>
      ))}

      {comments?.length === 0 && (
        <p className="muted" style={{ fontSize: 14 }}>
          No comments yet — start the conversation.
        </p>
      )}
    </div>
  );
}
