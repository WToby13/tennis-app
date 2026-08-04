"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useRef, useState } from "react";

interface Video {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  contentType: string;
  durationS: number | null;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const ASSUMED_FPS = 30; // frame-step granularity until we read real fps (post-MVP)

export default function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [copied, setCopied] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [canAdd, setCanAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  /** The share token from the URL, if the visitor arrived via a share link. */
  const shareToken = () =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("s");

  // Owner: mint (or reuse) a share link, then copy the absolute URL.
  const share = useCallback(async () => {
    let url = window.location.href;
    try {
      const res = await fetch(`/api/videos/${id}/share`, { method: "POST" });
      if (res.ok) {
        const { path } = await res.json();
        url = `${window.location.origin}${path}`;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this link to share:", url);
    }
  }, [id]);

  // Non-owner viewing via a share link: add it to their own library.
  const addToAccount = useCallback(async () => {
    const token = shareToken();
    if (!token) return;
    setAdding(true);
    try {
      const res = await fetch(`/api/videos/${id}/add`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        setAdded(true);
        setCanAdd(false);
      }
    } finally {
      setAdding(false);
    }
  }, [id]);

  // Load metadata; poll while still processing (relevant to the S3 faststart step).
  useEffect(() => {
    let active = true;
    async function load() {
      const token = shareToken();
      const res = await fetch(`/api/videos/${id}${token ? `?s=${encodeURIComponent(token)}` : ""}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!active) return;
      setVideo(data.video);
      setPlaybackUrl(data.playbackUrl);
      setThumbnailUrl(data.thumbnailUrl ?? null);
      setIsOwner(Boolean(data.isOwner));
      setCanAdd(Boolean(data.canAdd));
      if (data.video.status === "processing") setTimeout(load, 2000);
    }
    load();
    return () => {
      active = false;
    };
  }, [id]);

  const stepFrames = useCallback((frames: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = Math.max(0, el.currentTime + frames / ASSUMED_FPS);
  }, []);

  const changeSpeed = useCallback((s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }, []);

  // Keyboard: , / . step one frame; j / l jump 5s; k toggles play.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = videoRef.current;
      if (!el) return;
      if (e.key === ",") stepFrames(-1);
      else if (e.key === ".") stepFrames(1);
      else if (e.key === "j") el.currentTime = Math.max(0, el.currentTime - 5);
      else if (e.key === "l") el.currentTime += 5;
      else if (e.key === "k") el.paused ? el.play() : el.pause();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepFrames]);

  if (!video) return <p className="muted">Loading…</p>;

  return (
    <div>
      <Link href="/" className="muted">
        ← Match library
      </Link>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          marginTop: 8,
        }}
      >
        <h1 style={{ margin: 0 }}>{video.title}</h1>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {canAdd && !added && (
            <button className="btn" onClick={addToAccount} disabled={adding}>
              {adding ? "Adding…" : "+ Add to my account"}
            </button>
          )}
          {added && (
            <Link href="/" className="chip active">
              ✓ Added — go to library
            </Link>
          )}
          {isOwner && (
            <button className="chip active" onClick={share} title="Copy a link to send a friend">
              {copied ? "✓ Link copied" : "🔗 Share"}
            </button>
          )}
        </div>
      </div>

      {video.status === "ready" && playbackUrl ? (
        <>
          <video
            ref={videoRef}
            src={playbackUrl}
            poster={thumbnailUrl ?? undefined}
            controls
            preload="metadata"
          />

          <div className="controls">
            <div className="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`chip ${speed === s ? "active" : ""}`}
                  onClick={() => changeSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>

            <div className="group" aria-label="Frame step">
              <button className="chip" onClick={() => stepFrames(-1)} title="Previous frame ( , )">
                ⏮ frame
              </button>
              <button className="chip" onClick={() => stepFrames(1)} title="Next frame ( . )">
                frame ⏭
              </button>
            </div>
          </div>

          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Shortcuts: <b>,</b> / <b>.</b> step a frame · <b>j</b> / <b>l</b> jump 5s · <b>k</b> play/pause.
            Slow-motion is the 0.25× / 0.5× speeds.
          </p>
        </>
      ) : (
        <div className="card" style={{ padding: 40, textAlign: "center" }}>
          <span className={`badge ${video.status}`}>{video.status}</span>
          <p className="muted" style={{ marginTop: 12 }}>
            {video.status === "processing"
              ? "Preparing the video for smooth scrubbing…"
              : video.status === "uploading"
                ? "This match is still uploading."
                : "This video isn't available to play."}
          </p>
        </div>
      )}
    </div>
  );
}
