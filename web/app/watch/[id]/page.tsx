"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommentSection } from "../../CommentSection";
import { EditDetails, type EditableParticipant } from "../../EditDetails";
import { FollowButton } from "../../FollowButton";
import { LikeButton } from "../../LikeButton";
import { RallySegments } from "../../RallySegments";
import { VideoPlayer } from "../../VideoPlayer";
import { CloseIcon, CommentIcon, EditIcon, ShareIcon } from "../../icons";
import { track } from "@/lib/analytics/client";
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
  /** Playback position, driving the timeline playhead. Updated from the video's
   *  own timeupdate (~4/s) rather than a rAF loop — the playhead moves across a
   *  30-minute match, so sub-frame precision buys nothing and costs renders. */
  const [currentTime, setCurrentTime] = useState(0);
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

  /**
   * Naming the two players in the AI breakdown panel is a statement that they
   * played, so tag them on the match as well — linked to the account when the
   * name is the owner's, a guest otherwise. Anyone already tagged is kept as they
   * are, so an existing link or a pending invite survives.
   */
  const tagPlayers = useCallback(
    async (names: string[]) => {
      const merged = [...participants];
      for (const raw of names) {
        const name = raw.trim();
        if (!name) continue;
        if (merged.some((p) => p.displayName.trim().toLowerCase() === name.toLowerCase())) continue;
        const isAuthor = author?.displayName.trim().toLowerCase() === name.toLowerCase();
        merged.push({
          id: "",
          userId: isAuthor ? author!.id : null,
          displayName: name,
          email: null,
        });
      }
      if (merged.length === participants.length) return;
      const res = await fetch(`/api/videos/${id}/participants`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          participants: merged.map((p) => ({
            userId: p.userId,
            displayName: p.displayName,
            email: p.email,
          })),
        }),
      });
      if (res.ok) setParticipants((await res.json()).participants ?? merged);
    },
    [id, participants, author],
  );

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

  /**
   * Somebody followed a shared link.
   *
   * The denominator for share conversion (docs/GTM.md §6), and the only place it
   * can be counted: minting a link says nothing about whether it was ever
   * pasted anywhere. Note this fires for the *token* case only — the owner
   * opening their own match from the library is not a share being received.
   *
   * Today a signed-out recipient is redirected to /sign-in before reaching this
   * component at all, which is exactly why `sign_in_wall_hit` is recorded there
   * too. Once GTM blocker #2 is fixed and anonymous viewing works, this event
   * starts firing for them and the two together tell the whole story.
   */
  useEffect(() => {
    const token = shareToken();
    if (!token) return;
    track("share_link_opened", { via: "share_token" }, { videoId: id, now: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /**
   * Playback actually started, and roughly how much of it was watched.
   *
   * `watch_started` fires on the first play of the page, not on load — a page
   * view is not a watch, and counting it as one would make the second-watch
   * rate meaningless. `watch_ended` goes out on the way off the page, so
   * `watchedSeconds` is the honest answer to "did they stay".
   */
  const watchedFrom = useRef<number | null>(null);
  const startedRef = useRef(false);
  useEffect(() => {
    // Reset on the way *in*, not only on the way out. The app router can reuse
    // this component when only the [id] param changes, in which case the refs
    // survive — and a stale `startedRef` would swallow the next match's
    // watch_started entirely, which is the event the second-watch rate is built
    // on. Cheap to do, invisible when it isn't needed.
    startedRef.current = false;
    watchedFrom.current = null;

    return () => {
      if (watchedFrom.current === null) return;
      const watchedSeconds = Math.round((Date.now() - watchedFrom.current) / 1000);
      watchedFrom.current = null;
      if (watchedSeconds < 1) return;
      track("watch_ended", { watchedSeconds }, { videoId: id, now: true });
    };
  }, [id]);

  const onPlay = useCallback(() => {
    setPaused(false);
    if (watchedFrom.current === null) watchedFrom.current = Date.now();
    if (startedRef.current) return;
    startedRef.current = true;
    track("watch_started", { isOwner, viaShareToken: Boolean(shareToken()) }, { videoId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isOwner]);

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

  /**
   * Jump to the start of the next rally.
   *
   * The breakdown's whole claim is that the dead time between points is
   * skippable, and doing that from the timeline means hitting a bar that's a few
   * pixels wide on a phone. Reads the element's own clock rather than
   * `currentTime`, which only refreshes ~4x/s, so a press right after a seek
   * doesn't land back on the rally just left.
   */
  const nextRally = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    const after = el.currentTime + 0.25;
    let next: number | null = null;
    for (const s of segments) {
      const start = s.startS;
      if (start == null || start <= after) continue;
      if (next === null || start < next) next = start;
    }
    if (next !== null) seekTo(next);
  }, [segments, seekTo]);

  /**
   * A timestamp someone wrote in a comment. Plays from there like any other
   * seek, and pulls the player back into view — the comment that named the
   * moment is usually a screen or more below it, so seeking alone would look
   * like nothing happened.
   */
  const seekFromComment = useCallback(
    (seconds: number) => {
      seekTo(seconds);
      theaterRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [seekTo],
  );

  /** Start of the earliest rally, or null when there's no breakdown to go on. */
  const firstRallyStart = useMemo(() => {
    let first: number | null = null;
    for (const s of segments) {
      if (s.startS == null) continue;
      if (first === null || s.startS < first) first = s.startS;
    }
    return first;
  }, [segments]);

  /**
   * Where the match opens.
   *
   * `?t=` wins — that's a link to a named moment, from a feed card or the inbox,
   * neither of which has a player of its own. Otherwise, if the breakdown knows
   * where the first rally is, open there: everything before it is warm-up and
   * walking about, and nobody sits through that twice.
   *
   * Can only run once the asset has a duration (setting currentTime earlier is
   * silently dropped), and the segments can land either side of that, so it's an
   * effect over both rather than a metadata handler. Applied once, and never on
   * top of someone who has already started watching.
   */
  const [metadataReady, setMetadataReady] = useState(false);
  const appliedStartTime = useRef(false);
  // The router reuses this component when only [id] changes, so the ref has to
  // be cleared explicitly or the next match opens wherever this one left off.
  useEffect(() => {
    appliedStartTime.current = false;
    setMetadataReady(false);
  }, [id]);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !metadataReady || appliedStartTime.current) return;
    const t = Number(new URLSearchParams(window.location.search).get("t"));
    const target = Number.isFinite(t) && t > 0 ? t : firstRallyStart;
    if (target == null || target <= 0) return; // nothing to jump to — leave it at 0
    appliedStartTime.current = true;
    if (!el.paused || el.currentTime > 0.5) return; // they're already watching
    el.currentTime = target;
    setCurrentTime(target);
  }, [metadataReady, firstRallyStart]);

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
   * Fullscreening the <video> shows the element and nothing else: our overlay is
   * a sibling of it, and the rally timeline a floor above that, so both would be
   * left behind — and they are the entire reason to be on this page.
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
  // play; f toggles fullscreen; n jumps to the next rally; m mutes. Every one of
  // these is printed on the chip it belongs to, in the overlay over the video.
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
      else if (e.key === "n") nextRally();
      else if (e.key === "m") {
        el.muted = !el.muted;
        if (!el.muted && el.volume === 0) el.volume = 1;
      } else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepFrames, editing, toggleFullscreen, nextRally]);

  if (!video) {
    return (
      <div style={{ padding: 26 }} role="status" aria-label="Loading match">
        <div className="skeleton skeleton-line" style={{ width: 260, height: 22 }} />
        <div className="skeleton skeleton-thumb" style={{ marginTop: 18, borderRadius: 12 }} />
        <div className="skeleton skeleton-line" style={{ width: 320, marginTop: 18 }} />
      </div>
    );
  }

  // Whether there's a rally left to skip to, so the button greys out at the end
  // of the match rather than looking broken.
  const hasNextRally = segments.some((s) => s.startS != null && s.startS > currentTime + 0.25);

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
          <button
            className="btn secondary"
            onClick={() =>
              document.getElementById("comments")?.scrollIntoView({ behavior: "smooth" })
            }
            title="Jump to the comments"
          >
            <CommentIcon size={17} />
            Comments
          </button>
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
            <VideoPlayer
              src={playbackUrl!}
              poster={thumbnailUrl ?? undefined}
              videoRef={videoRef}
              currentTime={currentTime}
              paused={paused}
              speed={speed}
              showNextRally={segments.length > 0}
              hasNextRally={hasNextRally}
              isFullscreen={isFullscreen}
              onSpeedChange={changeSpeed}
              onStepFrames={stepFrames}
              onSeekBy={seek}
              onTogglePlay={togglePlay}
              onNextRally={nextRally}
              onToggleFullscreen={toggleFullscreen}
              onPlay={onPlay}
              onPause={() => setPaused(true)}
              onTimeChange={setCurrentTime}
              onLoadedMetadata={(el) => {
                setCurrentTime(el.currentTime);
                setMetadataReady(true);
              }}
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

        {/* Straight under the video: with the controls now over the picture,
            the breakdown is the first thing below it. */}
        {ready && (
          <RallySegments
            videoId={id}
            canRun={canAnalyze}
            durationS={video.durationS}
            initialStatus={analysisStatus}
            initialSegments={segments}
            initialError={analysisError}
            initialPlayers={analysisPlayers}
            // You first: only the owner can run a breakdown, and they're usually
            // one of the two players — but they'd never tagged themselves, so the
            // panel offered every name except their own.
            participantNames={[
              ...(isOwner && author ? [author.displayName] : []),
              ...participants.map((p) => p.displayName),
            ]}
            onSeek={seekTo}
            onPlayersNamed={tagPlayers}
            currentTime={currentTime}
          />
        )}
      </div>

      <div className="watch-below">
        <CommentSection videoId={id} onSeek={seekFromComment} />
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
