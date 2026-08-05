"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface C {
  id: string;
  authorName: string | null;
  body: string;
}

/** Compact comments for a feed card: latest two + "view all", plus an inline composer. */
export function FeedComments({ videoId, commentCount }: { videoId: string; commentCount: number }) {
  const [comments, setComments] = useState<C[]>([]);
  const [total, setTotal] = useState(commentCount);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (commentCount <= 0) return;
    fetch(`/api/videos/${videoId}/comments`)
      .then((r) => r.json())
      .then((d) => {
        setComments(d.comments ?? []);
        setTotal((d.comments ?? []).length);
      })
      .catch(() => {});
  }, [videoId, commentCount]);

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
        const d = await res.json();
        setComments(d.comments ?? []);
        setTotal((d.comments ?? []).length);
        setBody("");
      }
    } finally {
      setBusy(false);
    }
  }

  const preview = comments.slice(-2);

  return (
    <div className="feed-comments">
      {total > 2 && (
        <Link className="feed-viewall" href={`/watch/${videoId}`}>
          View all {total} comments
        </Link>
      )}
      {preview.map((c) => (
        <div key={c.id} className="feed-comment">
          <span className="who">{c.authorName}</span> {c.body}
        </div>
      ))}
      <form className="feed-add" onSubmit={submit}>
        <input
          id={`c-${videoId}`}
          type="text"
          placeholder="Add a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={busy}
        />
        <button className="post" type="submit" disabled={busy || !body.trim()}>
          Post
        </button>
      </form>
    </div>
  );
}
