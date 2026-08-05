"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { LikeButton } from "./LikeButton";
import { PeopleSearch } from "./PeopleSearch";
import { formatDate, formatDuration, STATUS_LABEL } from "@/lib/matchFormat";

interface FeedItem {
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
  thumbnailUrl: string | null;
}

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);

  useEffect(() => {
    fetch("/api/feed")
      .then((r) => r.json())
      .then((d) => setFeed(d.feed))
      .catch(() => setFeed([]));
  }, []);

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        For you
      </div>
      <h1 style={{ marginBottom: 6 }}>Latest matches</h1>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Matches from players you follow, and your own.
      </p>

      {feed === null && (
        <p className="muted" style={{ marginTop: 20 }}>
          Loading…
        </p>
      )}

      {feed?.length === 0 && (
        <div className="feed">
          <div className="card" style={{ padding: 32, textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: 16 }}>
              Your feed is empty. Follow players to see their matches here — or record and upload
              your own.
            </p>
            <PeopleSearch />
          </div>
        </div>
      )}

      {feed && feed.length > 0 && (
        <div className="feed">
          {feed.map((v) => {
            const who = v.sharedBy ? v.sharedByName : v.authorName;
            const whoId = v.sharedBy ?? v.ownerId;
            return (
              <article key={v.id} className="feed-card">
                <div className="feed-author">
                  <Avatar name={who} size={36} />
                  <div style={{ lineHeight: 1.3 }}>
                    {whoId ? (
                      <Link href={`/u/${whoId}`} style={{ color: "inherit", fontWeight: 600 }}>
                        {who ?? "Ojo player"}
                      </Link>
                    ) : (
                      <span style={{ fontWeight: 600 }}>{who ?? "Ojo player"}</span>
                    )}
                    {v.sharedBy && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        shared a match
                      </div>
                    )}
                  </div>
                </div>

                <Link href={`/watch/${v.id}`} style={{ color: "inherit" }}>
                  <div className="thumb">
                    {v.thumbnailUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={v.thumbnailUrl}
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

                <div className="body">
                  <div className="feed-head">
                    <Link
                      href={`/watch/${v.id}`}
                      style={{ color: "inherit", fontWeight: 700, fontSize: 17 }}
                    >
                      {v.title}
                    </Link>
                    <span className={`badge ${v.status}`}>{STATUS_LABEL[v.status]}</span>
                  </div>
                  <div className="muted mono" style={{ fontSize: 13, marginTop: 6 }}>
                    {formatDate(v.createdAt)} · {formatDuration(v.durationS)}
                    {v.participantNames && ` · ${v.participantNames}`}
                  </div>
                  <div className="feed-actions">
                    <LikeButton
                      videoId={v.id}
                      initialCount={v.likeCount}
                      initialLiked={v.likedByMe}
                    />
                    <Link href={`/watch/${v.id}`} className="chip">
                      💬 {v.commentCount}
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
