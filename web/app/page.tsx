"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Video {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  durationS: number | null;
  sizeBytes: number;
  createdAt: string;
}

function formatDuration(s: number | null): string {
  if (!s) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export default function MatchesPage() {
  const [videos, setVideos] = useState<Video[] | null>(null);

  useEffect(() => {
    fetch("/api/videos")
      .then((r) => r.json())
      .then((d) => setVideos(d.videos))
      .catch(() => setVideos([]));
  }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Matches</h1>
        <Link href="/upload" className="btn">
          + Upload a match
        </Link>
      </div>

      {videos === null && <p className="muted">Loading…</p>}

      {videos?.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: "center", marginTop: 16 }}>
          <p style={{ fontSize: 40, margin: 0 }}>🎾</p>
          <p className="muted">No matches yet. Upload your first recording to get started.</p>
          <Link href="/upload" className="btn">
            Upload a match
          </Link>
        </div>
      )}

      {videos && videos.length > 0 && (
        <div className="grid" style={{ marginTop: 20 }}>
          {videos.map((v) => (
            <Link key={v.id} href={`/watch/${v.id}`} className="card" style={{ color: "inherit" }}>
              <div className="thumb">🎾</div>
              <div style={{ padding: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {v.title}
                  </strong>
                  <span className={`badge ${v.status}`}>{v.status}</span>
                </div>
                <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
                  {formatDuration(v.durationS)} · {formatSize(v.sizeBytes)}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
