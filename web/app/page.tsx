"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ShareButton } from "./ShareButton";
import {
  formatDate,
  formatDuration,
  formatSize,
  STATUS_LABEL,
  type MatchVideo,
} from "@/lib/matchFormat";

export default function FeedPage() {
  const [videos, setVideos] = useState<MatchVideo[] | null>(null);

  useEffect(() => {
    fetch("/api/videos")
      .then((r) => r.json())
      .then((d) => setVideos(d.videos))
      .catch(() => setVideos([]));
  }, []);

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        For you
      </div>
      <h1 style={{ marginBottom: 6 }}>Latest matches</h1>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Your most recent recordings, newest first.
      </p>

      {videos === null && (
        <p className="muted" style={{ marginTop: 20 }}>
          Loading…
        </p>
      )}

      {videos?.length === 0 && (
        <div className="feed">
          <div className="card" style={{ padding: 40, textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/monogram.svg"
              alt=""
              width={56}
              height={56}
              style={{ opacity: 0.45, margin: "0 auto 8px" }}
            />
            <p className="muted">
              Nothing here yet. Record a match in the iPhone app, or upload one to get started.
            </p>
            <Link href="/upload" className="btn">
              Upload a match
            </Link>
          </div>
        </div>
      )}

      {videos && videos.length > 0 && (
        <div className="feed">
          {videos.map((v) => (
            <article key={v.id} className="feed-card">
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
                  {formatDate(v.createdAt)} · {formatDuration(v.durationS)} · {formatSize(v.sizeBytes)}
                  {v.addedVia === "share" && " · Added"}
                </div>
                <div className="feed-actions">
                  <Link href={`/watch/${v.id}`} className="chip active">
                    ▶ Watch
                  </Link>
                  {v.addedVia === "upload" && v.status === "ready" && <ShareButton id={v.id} />}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
