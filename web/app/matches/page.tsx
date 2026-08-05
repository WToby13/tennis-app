"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ShareButton } from "../ShareButton";
import {
  formatDate,
  formatDuration,
  formatSize,
  STATUS_LABEL,
  type MatchVideo,
} from "@/lib/matchFormat";

export default function MatchesPage() {
  const [videos, setVideos] = useState<MatchVideo[] | null>(null);

  useEffect(() => {
    fetch("/api/videos")
      .then((r) => r.json())
      .then((d) => setVideos(d.videos))
      .catch(() => setVideos([]));
  }, []);

  /** Drop a shared video from my library (does not delete the original). */
  async function removeFromLibrary(id: string) {
    setVideos((vs) => (vs ?? []).filter((v) => v.id !== id));
    await fetch(`/api/videos/${id}/library`, { method: "DELETE" }).catch(() => {});
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            Library
          </div>
          <h1 style={{ marginBottom: 6 }}>Your matches</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Only you can see these. Share a link to let a friend watch or add it.
          </p>
        </div>
        <Link href="/upload" className="btn">
          Upload a match
        </Link>
      </div>

      {videos === null && (
        <p className="muted" style={{ marginTop: 20 }}>
          Loading…
        </p>
      )}

      {videos?.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: "center", marginTop: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/monogram.svg"
            alt=""
            width={56}
            height={56}
            style={{ opacity: 0.45, margin: "0 auto 8px" }}
          />
          <p className="muted">
            No matches yet. Record one in the iPhone app, or upload a file to get started.
          </p>
          <Link href="/upload" className="btn">
            Upload a match
          </Link>
        </div>
      )}

      {videos && videos.length > 0 && (
        <div className="grid" style={{ marginTop: 20 }}>
          {videos.map((v) => (
            <div key={v.id} className="card">
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
              <div style={{ padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <Link
                    href={`/watch/${v.id}`}
                    style={{
                      color: "inherit",
                      fontWeight: 700,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {v.title}
                  </Link>
                  <span className={`badge ${v.status}`}>{STATUS_LABEL[v.status]}</span>
                </div>
                <div className="muted mono" style={{ fontSize: 13, marginTop: 6 }}>
                  {formatDate(v.createdAt)} · {formatDuration(v.durationS)} · {formatSize(v.sizeBytes)}
                  {v.addedVia === "share" && " · Added"}
                  {v.addedVia === "participant" && " · Tagged"}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                  <Link href={`/watch/${v.id}`} className="btn btn-sm">
                    Watch
                  </Link>
                  {v.status === "ready" && <ShareButton id={v.id} />}
                  {v.addedVia !== "upload" && (
                    <button className="btn secondary btn-sm" onClick={() => removeFromLibrary(v.id)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
