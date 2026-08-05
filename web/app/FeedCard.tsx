"use client";

import Link from "next/link";
import { useState } from "react";
import { Avatar } from "./Avatar";
import { FeedComments } from "./FeedComments";
import { BookmarkIcon, CommentIcon, HeartIcon, ShareIcon } from "./icons";
import { useLike } from "./useLike";
import { formatDate, formatDuration } from "@/lib/matchFormat";

export interface FeedItem {
  id: string;
  ownerId: string | null;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  durationS: number | null;
  createdAt: string;
  authorName: string | null;
  sharedBy: string | null;
  sharedByName: string | null;
  participantNames: string | null;
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  inLibrary: boolean;
  thumbnailUrl: string | null;
}

export function FeedCard({ item }: { item: FeedItem }) {
  const { liked, count, busy, toggle } = useLike(item.id, item.likeCount, item.likedByMe);
  const [saved, setSaved] = useState(item.inLibrary);
  const who = item.sharedBy ? item.sharedByName : item.authorName;
  const whoId = item.sharedBy ?? item.ownerId;

  async function copyShareLink() {
    let url = `${window.location.origin}/watch/${item.id}`;
    try {
      const res = await fetch(`/api/videos/${item.id}/share`, { method: "POST" });
      if (res.ok) url = `${window.location.origin}${(await res.json()).path}`;
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy this link to share:", url);
    }
  }

  async function save() {
    if (saved) return;
    setSaved(true);
    await fetch(`/api/videos/${item.id}/save`, { method: "POST" }).catch(() => setSaved(false));
  }

  const meta = [item.participantNames, formatDate(item.createdAt), formatDuration(item.durationS)]
    .filter(Boolean)
    .join(" · ");

  return (
    <article className="feed-card">
      <div className="feed-author">
        <Avatar name={who} size={38} />
        <div style={{ lineHeight: 1.25 }}>
          {whoId ? (
            <Link href={`/u/${whoId}`} className="name">
              {who ?? "Ojo player"}
            </Link>
          ) : (
            <span className="name">{who ?? "Ojo player"}</span>
          )}
          {item.sharedBy && <div className="sub">shared a match</div>}
        </div>
      </div>

      <Link href={`/watch/${item.id}`} className="feed-media" style={{ color: "inherit" }}>
        <div className="thumb">
          {item.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.thumbnailUrl}
              alt=""
              className="thumb-img"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          )}
          <span className="play" />
        </div>
      </Link>

      <div className="feed-row">
        <button
          className={`icon-btn ${liked ? "liked" : ""}`}
          onClick={toggle}
          disabled={busy}
          aria-label={liked ? "Unlike" : "Like"}
        >
          <HeartIcon filled={liked} />
        </button>
        <button
          className="icon-btn"
          onClick={() => document.getElementById(`c-${item.id}`)?.focus()}
          aria-label="Comment"
        >
          <CommentIcon />
        </button>
        <button className="icon-btn" onClick={copyShareLink} aria-label="Copy share link">
          <ShareIcon />
        </button>
        <span className="spacer" />
        <button
          className={`icon-btn ${saved ? "on" : ""}`}
          onClick={save}
          disabled={saved}
          aria-label="Add to profile"
          title={saved ? "In your profile" : "Add to profile"}
        >
          <BookmarkIcon filled={saved} />
        </button>
      </div>

      {count > 0 && (
        <div className="feed-likes">
          {count} {count === 1 ? "like" : "likes"}
        </div>
      )}

      <div className="feed-caption">
        <Link href={`/watch/${item.id}`} className="title" style={{ color: "inherit" }}>
          {item.title}
        </Link>
        {meta && <div className="meta">{meta}</div>}
      </div>

      <FeedComments videoId={item.id} commentCount={item.commentCount} />
    </article>
  );
}
