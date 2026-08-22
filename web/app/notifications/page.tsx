"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "../Avatar";
import { CommentBody } from "../CommentBody";
import type { Notification } from "@/lib/social";

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The inbox: who said what, on which match, and a way straight to it. */
export default function NotificationsPage() {
  const [items, setItems] = useState<Notification[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications");
        const list = res.ok ? ((await res.json()).notifications ?? []) : [];
        if (cancelled) return;
        setItems(list);
        // Opening the inbox is what "read" means here, so clear the badge as
        // soon as the rows are on screen. The unread styling below is painted
        // from the copy already in state, so this doesn't wipe the page.
        if (list.some((n: Notification) => !n.readAt)) {
          await fetch("/api/notifications/read", { method: "POST" });
        }
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        Activity
      </div>
      <h1 style={{ marginBottom: 6 }}>Notifications</h1>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        When someone tags you, or adds to a conversation you&rsquo;re in.
      </p>

      {items === null && (
        <div style={{ marginTop: 24 }}>
          <div className="skeleton skeleton-line" style={{ width: 320 }} />
          <div className="skeleton skeleton-line" style={{ width: 260, marginTop: 12 }} />
        </div>
      )}

      {items?.length === 0 && (
        <div className="card" style={{ padding: 32, textAlign: "center", marginTop: 24 }}>
          <p className="muted" style={{ margin: 0 }}>
            Nothing yet. Tag someone with @ in a comment and they&rsquo;ll hear about it here.
          </p>
        </div>
      )}

      {items && items.length > 0 && (
        <ul className="notif-list">
          {items.map((n) => (
            <li key={n.id} className={n.readAt ? "notif" : "notif unread"}>
              <Link
                href={
                  n.commentId
                    ? `/watch/${n.videoId}#comment-${n.commentId}`
                    : `/watch/${n.videoId}`
                }
              >
                <Avatar name={n.actorName} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="notif-head">
                    <b>{n.actorName ?? "Someone"}</b>{" "}
                    {n.kind === "mention" ? "tagged you in" : "commented on"}{" "}
                    <span className="notif-match">{n.videoTitle ?? "a match"}</span>
                    <span className="muted"> · {timeAgo(n.createdAt)}</span>
                  </div>
                  {n.body && (
                    <div className="notif-body">
                      {/* Plain rendering: no player on this page to seek. */}
                      <CommentBody body={n.body} videoId={n.videoId} />
                    </div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
