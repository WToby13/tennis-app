"use client";

import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { CommentBody } from "./CommentBody";
import { MentionComposer } from "./MentionComposer";
import { TrashIcon } from "./icons";
import { ModerationMenu } from "./ModerationMenu";

interface CommentT {
  id: string;
  authorId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
  canDelete: boolean;
  /** The caller wrote this one — distinct from canDelete, which a match owner also has. */
  isMine?: boolean;
}

function timeAgo(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Match-level comments: composer + list, below the video.
 *
 * `onSeek` is handed down from the watch page so a timestamp someone wrote in a
 * comment plays the match from there.
 */
export function CommentSection({
  videoId,
  onSeek,
}: {
  videoId: string;
  onSeek?: (seconds: number) => void;
}) {
  const [comments, setComments] = useState<CommentT[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** The comment a notification link points at, so it can be found on arrival. */
  const [focused, setFocused] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/videos/${videoId}/comments`)
      .then((r) => r.json())
      .then((d) => setComments(d.comments ?? []))
      .catch(() => setComments([]));
  }, [videoId]);

  // Arriving from the inbox: #comment-<id> scrolls to it and marks it for a
  // moment. Runs after the list lands, because the element does not exist until
  // then.
  useEffect(() => {
    if (!comments?.length) return;
    const hash = window.location.hash;
    if (!hash.startsWith("#comment-")) return;
    const id = hash.slice("#comment-".length);
    if (!comments.some((c) => c.id === id)) return;
    setFocused(id);
    document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [comments]);

  async function post(body: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (res.ok) setComments((await res.json()).comments ?? []);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setComments((c) => (c ?? []).filter((x) => x.id !== id));
    await fetch(`/api/videos/${videoId}/comments/${id}`, { method: "DELETE" }).catch(() => {});
  }

  /** Blocking has to clear their comments from the page now, not on next load. */
  function hideAuthor(authorId: string) {
    setComments((c) => (c ?? []).filter((x) => x.authorId !== authorId));
  }

  return (
    <div className="comments" id="comments">
      <h3 style={{ fontSize: 15, marginBottom: 12 }}>
        Comments{comments ? ` (${comments.length})` : ""}
      </h3>

      <MentionComposer onPost={post} busy={busy} placeholder="Add a comment… @ to tag a player" />

      {comments?.map((c) => (
        <div
          key={c.id}
          id={`comment-${c.id}`}
          className={`comment${focused === c.id ? " comment-focus" : ""}`}
        >
          <Avatar name={c.authorName} size={30} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13 }}>
              <b>{c.authorName}</b>{" "}
              <span className="muted" style={{ fontSize: 12 }}>
                {timeAgo(c.createdAt)}
              </span>
            </div>
            <div style={{ fontSize: 14, marginTop: 2, wordBreak: "break-word" }}>
              <CommentBody body={c.body} videoId={videoId} onSeek={onSeek} />
            </div>
          </div>
          {c.canDelete && (
            <button className="comment-del" onClick={() => remove(c.id)} aria-label="Delete comment">
              <TrashIcon size={16} />
            </button>
          )}
          <ModerationMenu
            target={{
              kind: "comment",
              id: c.id,
              videoId,
              authorId: c.authorId,
              authorName: c.authorName,
            }}
            isMine={c.isMine ?? false}
            onBlocked={() => hideAuthor(c.authorId)}
          />
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
