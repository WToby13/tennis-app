"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { CommentSection } from "../../CommentSection";
import { EditDetails, type EditableParticipant } from "../../EditDetails";
import { FollowButton } from "../../FollowButton";
import { LikeButton } from "../../LikeButton";
import { RallySegments } from "../../RallySegments";
import {
  CloseIcon,
  EditIcon,
  NextFrameIcon,
  PauseIcon,
  PlayIcon,
  PrevFrameIcon,
  ShareIcon,
} from "../../icons";
import { formatDate, formatDuration, formatSize } from "@/lib/matchFormat";

interface Author {
  id: string;
  displayName: string;
}

interface Video {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  contentType: string;
  durationS: number | null;
  sizeBytes: number;
  createdAt: string;
  recordedAt: string | null;
  visibility: "private" | "unlisted" | "public";
}

interface Participant {
  id: string;
  userId: string | null;
  displayName: string;
  email: string | null;
}

interface Segment {
  id: string;
  idx: number;
  startS: number | null;
  endS: number | null;
  metadata: Record<string, unknown>;
}

type AnalysisStatus = "none" | "processing" | "ready" | "failed";

const SPEEDS = [0.25, 0.5, 1, 1.5, 2];
const ASSUMED_FPS = 30; // frame-step granularity until we read real fps (post-MVP)

export default function WatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The video + its review controls, fullscreened as one unit. */
  const theaterRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [video, setVideo] = useState<Video | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [copied, setCopied] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [canAdd, setCanAdd] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [paused, setPaused] = useState(true);
  // Social state.
  const [likeCount, setLikeCount] = useState(0);
  const [likedByMe, setLikedByMe] = useState(false);
  const [author, setAuthor] = useState<Author | null>(null);
  const [isFollowingOwner, setIsFollowingOwner] = useState(false);
  const [sharedToFollowers, setSharedToFollowers] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  // AI rally analysis.
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>("none");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [canAnalyze, setCanAnalyze] = useState(false);
  const [analysisPlayers, setAnalysisPlayers] = useState<{
    player_1: string | null;
    player_2: string | null;
  } | null>(null);

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

  // Post this match to my followers (or stop). Available to owner/participants.
  const toggleShareToFollowers = useCallback(async () => {
    setSharingBusy(true);
    const next = !sharedToFollowers;
    try {
      const res = await fetch(`/api/videos/${id}/share-to-followers`, {
        method: next ? "POST" : "DELETE",
      });
      if (res.ok) setSharedToFollowers((await res.json()).shared);
    } finally {
      setSharingBusy(false);
    }
  }, [id, sharedToFollowers]);

  // Owner-only match visibility (private/public).
  const changeVisibility = useCallback(
    async (v: "private" | "public") => {
      setVisibility(v);
      await fetch(`/api/videos/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: v }),
      }).catch(() => {});
    },
    [id],
  );

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
      setCanEdit(Boolean(data.canEdit));
      setCanAdd(Boolean(data.canAdd));
      setParticipants(data.participants ?? []);
      setLikeCount(data.likeCount ?? 0);
      setLikedByMe(Boolean(data.likedByMe));
      setAuthor(data.author ?? null);
      setIsFollowingOwner(Boolean(data.isFollowingOwner));
      setSharedToFollowers(Boolean(data.sharedToFollowers));
      setVisibility(data.video.visibility === "public" ? "public" : "private");
      setAnalysisStatus((data.analysisStatus as AnalysisStatus) ?? "none");
      setSegments(data.segments ?? []);
      setAnalysisError(data.analysisError ?? null);
      setCanAnalyze(Boolean(data.canAnalyze));
      setAnalysisPlayers(data.analysisPlayers ?? null);
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

  const seek = useCallback((deltaSeconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, el.currentTime + deltaSeconds);
  }, []);

  // Jump to an absolute time (used by the rally list) and start playing.
  const seekTo = useCallback((seconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, seconds);
    el.play().catch(() => {});
  }, []);

  const togglePlay = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  }, []);

  const changeSpeed = useCallback((s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  }, []);

  /**
   * Fullscreen the whole review area, not the <video>.
   *
   * Native video fullscreen drops you into a bare player — no frame-step, no
   * speed, no rally timeline — which is the entire reason to be on this page.
   * Fullscreening the container keeps the review tooling with the video.
   */
  const toggleFullscreen = useCallback(() => {
    const el = theaterRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Keyboard: , / . step one frame; j / l / arrows jump 5s; k or space toggles
  // play; f toggles fullscreen.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = videoRef.current;
      if (!el || editing) return;
      // Don't steal keys from whatever the user is typing into (the comment box
      // is right below the player, and "k" used to toggle playback mid-sentence).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === ",") stepFrames(-1);
      else if (e.key === ".") stepFrames(1);
      else if (e.key === "j" || e.key === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
      else if (e.key === "l" || e.key === "ArrowRight") el.currentTime += 5;
      else if (e.key === "k" || e.key === " ") el.paused ? el.play() : el.pause();
      else if (e.key === "f") toggleFullscreen();
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepFrames, editing, toggleFullscreen]);

  if (!video) {
    return (
      <div style={{ padding: 26 }} role="status" aria-label="Loading match">
        <div className="skeleton skeleton-line" style={{ width: 260, height: 22 }} />
        <div className="skeleton skeleton-thumb" style={{ marginTop: 18, borderRadius: 12 }} />
        <div className="skeleton skeleton-line" style={{ width: 320, marginTop: 18 }} />
      </div>
    );
  }

  const players = participants.map((p) => p.displayName).join(", ");
  const dateStr = formatDate(video.recordedAt ?? video.createdAt);
  const ready = video.status === "ready" && playbackUrl;

  return (
    <>
      <header className="watch-header">
        <div style={{ minWidth: 0 }}>
          <h1>{video.title}</h1>
          <div className="watch-meta muted">
            {author && (
              <>
                <Link href={`/u/${author.id}`} style={{ color: "inherit", fontWeight: 600 }}>
                  {author.displayName}
                </Link>
                {" · "}
              </>
            )}
            {dateStr} · {formatDuration(video.durationS)}
            {players && ` · with ${players}`}
          </div>
        </div>
        <div className="watch-cta">
          <LikeButton videoId={id} initialCount={likeCount} initialLiked={likedByMe} />
          {!isOwner && author && (
            <FollowButton userId={author.id} initialFollowing={isFollowingOwner} />
          )}
          {canEdit && (
            <button
              className={`btn secondary ${sharedToFollowers ? "on" : ""}`}
              onClick={toggleShareToFollowers}
              disabled={sharingBusy}
              title="Post this match to your followers' feeds"
            >
              {sharedToFollowers ? "Shared to followers" : "Share to followers"}
            </button>
          )}
          {canAdd && !added && (
            <button className="btn" onClick={addToAccount} disabled={adding}>
              {adding ? "Adding…" : "Add to my account"}
            </button>
          )}
          {added && (
            <Link href="/" className="btn secondary">
              Added — go to library
            </Link>
          )}
          <button className="btn secondary" onClick={share} title="Copy a link to share">
            <ShareIcon size={17} />
            {copied ? "Copied" : "Share"}
          </button>
          {canEdit && (
            <button className="btn secondary" onClick={openEdit}>
              <EditIcon size={17} />
              Edit
            </button>
          )}
        </div>
      </header>

      <div className={`theater ${isFullscreen ? "is-fullscreen" : ""}`} ref={theaterRef}>
        <div className="watch-stage">
          {ready ? (
            <video
              ref={videoRef}
              src={playbackUrl!}
              poster={thumbnailUrl ?? undefined}
              controls
              preload="metadata"
              onPlay={() => setPaused(false)}
              onPause={() => setPaused(true)}
              onDoubleClick={toggleFullscreen}
            />
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

        {ready && (
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
                <button className="chip chip-icon" onClick={() => stepFrames(-1)} title="Previous frame">
                  <PrevFrameIcon size={16} /> <span className="kbd">,</span>
                </button>
                <button className="chip chip-icon" onClick={() => stepFrames(1)} title="Next frame">
                  <span className="kbd">.</span> <NextFrameIcon size={16} />
                </button>
              </div>
              <div className="group" aria-label="Skip and play">
                <button className="chip" onClick={() => seek(-10)}>−10s</button>
                <button className="chip" onClick={() => seek(-5)}>
                  −5s <span className="kbd">j</span>
                </button>
                <button className="chip chip-icon" onClick={togglePlay} title={paused ? "Play" : "Pause"}>
                  {paused ? <PlayIcon size={16} /> : <PauseIcon size={16} />} <span className="kbd">k</span>
                </button>
                <button className="chip" onClick={() => seek(5)}>
                  +5s <span className="kbd">l</span>
                </button>
                <button className="chip" onClick={() => seek(10)}>+10s</button>
              </div>
              <div className="group" aria-label="View">
                <button
                  className="chip"
                  onClick={toggleFullscreen}
                  title={isFullscreen ? "Exit fullscreen" : "Fullscreen (keeps these controls)"}
                >
                  {isFullscreen ? "Exit fullscreen" : "Fullscreen"}{" "}
                  <span className="kbd">f</span>
                </button>
              </div>
            </div>
        )}
      </div>

      <div className="watch-below">
        {ready && (
          <RallySegments
            videoId={id}
            canRun={canAnalyze}
            durationS={video.durationS}
            initialStatus={analysisStatus}
            initialSegments={segments}
            initialError={analysisError}
            initialPlayers={analysisPlayers}
            participantNames={participants.map((p) => p.displayName)}
            onSeek={seekTo}
          />
        )}

        <CommentSection videoId={id} />
      </div>

      {editing && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2 style={{ fontSize: 18 }}>Match details</h2>
              <button className="modal-close" aria-label="Close" onClick={closeModal}>
                <CloseIcon size={20} />
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

            {isOwner && (
              <div className="field">
                <span className="lbl">Who can find this match</span>
                <div className="segmented">
                  {(["private", "public"] as const).map((v) => (
                    <label key={v} className={visibility === v ? "on" : ""}>
                      <input
                        type="radio"
                        name="visibility"
                        checked={visibility === v}
                        onChange={() => changeVisibility(v)}
                      />
                      {v === "private" ? "Private" : "Public"}
                    </label>
                  ))}
                </div>
                <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Public matches can be found by anyone and appear on your profile. Either way, use
                  “Share to followers” to post it to your feed.
                </p>
              </div>
            )}

            {isOwner && confirmingDelete ? (
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
                  <ShareIcon size={17} />
                  {copied ? "Copied" : "Share"}
                </button>
                {/* Only the owner can delete; participants can edit everything else. */}
                {isOwner && (
                  <button
                    className="btn secondary danger-outline"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete match
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
