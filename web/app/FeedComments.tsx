"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CommentBody } from "./CommentBody";
import { MentionComposer } from "./MentionComposer";

interface C {
  id: string;
  authorName: string | null;
  body: string;
}

/** Compact comments for a feed card: latest two + "view all", plus an inline composer. */
export function FeedComments({ videoId, commentCount }: { videoId: string; commentCount: number }) {
  const [comments, setComments] = useState<C[]>([]);
  const [total, setTotal] = useState(commentCount);
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

  async function post(body: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.ok) {
        const d = await res.json();
        setComments(d.comments ?? []);
        setTotal((d.comments ?? []).length);
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
          <span className="who">{c.authorName}</span>{" "}
          {/* No player on a feed card, so a timestamp links into the match. */}
          <CommentBody body={c.body} videoId={videoId} />
        </div>
      ))}
      <MentionComposer onPost={post} busy={busy} compact inputId={`c-${videoId}`} />
    </div>
  );
}
