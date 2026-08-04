"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { EditDetails, type EditableParticipant } from "../../EditDetails";
import { formatDate, formatDuration, formatSize } from "@/lib/matchFormat";

interface Video {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  contentType: string;
  durationS: number | null;
  sizeBytes: number;
  createdAt: string;
  recordedAt: string | null;
}

interface Participant {
  id: string;
  userId: string | null;
  displayName: string;
  email: string | null;
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const ASSUMED_FPS = 30; // frame-step granularity until we read real fps (post-MVP)

export default function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
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
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const shareToken = () =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("s");

  // Anyone with access can share: mint their own link; a token-only viewer just
  // forwards the link they already have (current URL).
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

  const openEdit = useCallback(() => {
    videoRef.current?.pause();
    setConfirmingDelete(false);
    setEditing(true);
  }, []);

  const closeModal = useCallback(() => {
    setEditing(false);
    setConfirmingDelete(false);
  }, []);

  const remove = useCallback(async () => {
    setDeleting(true);
    const res = await fetch(`/api/videos/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/");
    } else {
      setDeleting(false);
    }
  }, [id, router]);

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
      setParticipants(data.participants ?? []);
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
      if (!el || editing) return;
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
  }, [stepFrames, editing]);

  if (!video) return <p className="muted" style={{ padding: 26 }}>Loading…</p>;

  const players = participants.map((p) => p.displayName).join(", ");
  const dateStr = formatDate(video.recordedAt ?? video.createdAt);
  const ready = video.status === "ready" && playbackUrl;

  return (
    <>
      <header className="watch-header">
        <div style={{ minWidth: 0 }}>
          <h1>{video.title}</h1>
          <div className="watch-meta muted">
            {dateStr} · {formatDuration(video.durationS)}
            {players && ` · with ${players}`}
          </div>
        </div>
        <div className="watch-cta">
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
          <button className="chip active" onClick={share} title="Copy a link to share">
            {copied ? "✓ Link copied" : "🔗 Share"}
          </button>
          {isOwner && (
            <button className="chip" onClick={openEdit}>
              ✎ Edit
            </button>
          )}
        </div>
      </header>

      <div className="watch-stage">
        {ready ? (
          <video ref={videoRef} src={playbackUrl!} poster={thumbnailUrl ?? undefined} controls preload="metadata" />
        ) : (
          <div className="placeholder">
            <span className={`badge ${video.status}`}>{video.status}</span>
            <p style={{ margin: 0 }}>
              {video.status === "processing"
                ? "Preparing the video for smooth scrubbing…"
                : video.status === "uploading"
                  ? "This match is still uploading."
                  : "This video isn't available to play."}
            </p>
          </div>
        )}
      </div>

      <div className="watch-below">
        {ready && (
          <>
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
              Shortcuts: <b>,</b> / <b>.</b> step a frame · <b>j</b> / <b>l</b> jump 5s · <b>k</b>{" "}
              play/pause. Slow-motion is the 0.25× / 0.5× speeds.
            </p>
          </>
        )}

        <div className="coming-soon">
          <h3>Clips &amp; editing</h3>
          Trim highlights and build reels from this match — coming soon.
        </div>
        <div className="coming-soon">
          <h3>Comments</h3>
          Talk through the points with the people you played — coming soon.
        </div>
      </div>

      {editing && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 style={{ fontSize: 18 }}>Match details</h2>
              <button className="modal-close" aria-label="Close" onClick={closeModal}>
                ×
              </button>
            </div>

            <EditDetails
              bare
              videoId={id}
              initialTitle={video.title}
              initialParticipants={participants.map(
                (p): EditableParticipant => ({ userId: p.userId, displayName: p.displayName, email: p.email }),
              )}
              onCancel={closeModal}
              onSaved={(title, list) => {
                setVideo((v) => (v ? { ...v, title } : v));
                setParticipants(
                  list.map((p, i) => ({ id: String(i), userId: p.userId, displayName: p.displayName, email: p.email })),
                );
                closeModal();
              }}
            />

            <div className="field" style={{ marginTop: 8 }}>
              <span className="lbl">Details</span>
              <div className="detail-row">
                <span className="k">Recorded</span>
                <span className="mono">{dateStr}</span>
              </div>
              <div className="detail-row">
                <span className="k">Duration</span>
                <span className="mono">{formatDuration(video.durationS)}</span>
              </div>
              <div className="detail-row">
                <span className="k">Size</span>
                <span className="mono">{formatSize(video.sizeBytes)}</span>
              </div>
            </div>

            {confirmingDelete ? (
              <div className="danger-confirm">
                <p style={{ margin: "0 0 12px" }}>
                  Delete <b>{video.title}</b> for everyone? Anyone it was shared with loses access
                  and this can’t be undone.
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn danger" onClick={remove} disabled={deleting}>
                    {deleting ? "Deleting…" : "Yes, delete match"}
                  </button>
                  <button
                    className="btn secondary"
                    onClick={() => setConfirmingDelete(false)}
                    disabled={deleting}
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="btn secondary" onClick={share}>
                  {copied ? "✓ Link copied" : "🔗 Share"}
                </button>
                <button
                  className="btn secondary danger-outline"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete match
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
