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
  thumbnailUrl: string | null;
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const STATUS_LABEL: Record<Video["status"], string> = {
  uploading: "Uploading",
  processing: "Processing",
  ready: "Ready",
  failed: "Failed",
};

/** Copy a shareable watch link to the clipboard. */
function ShareButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="chip"
      onClick={async () => {
        const url = `${window.location.origin}/watch/${id}`;
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          window.prompt("Copy this link to share:", url);
        }
      }}
    >
      {copied ? "✓ Copied" : "🔗 Share"}
    </button>
  );
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
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Library</div>
          <h1 style={{ marginBottom: 6 }}>Your matches</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Everyone signed in can watch these — share a link with a friend.
          </p>
        </div>
        <Link href="/upload" className="btn">
          Upload a match
        </Link>
      </div>

      {videos === null && <p className="muted" style={{ marginTop: 20 }}>Loading…</p>}

      {videos?.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: "center", marginTop: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/monogram.svg" alt="" width={56} height={56} style={{ opacity: 0.45, margin: "0 auto 8px" }} />
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
                        // No thumbnail uploaded (e.g. older match) — fall back to the court tile.
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
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Link href={`/watch/${v.id}`} className="chip active">
                    ▶ Watch
                  </Link>
                  {v.status === "ready" && <ShareButton id={v.id} />}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
