"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ShareButton } from "./ShareButton";
import {
  formatDate,
  formatDuration,
  formatElapsed,
  formatSize,
  type MatchVideo,
} from "@/lib/matchFormat";
import { SHARE_CHIP, activityChip, canAnalyse, type MatchStatus } from "@/lib/matchStatus";

/**
 * How often an in-flight match is re-checked. Note this is not just UI polling:
 * `GET /analyze` is what advances the TwelveLabs state machine (there's no
 * background worker — see app/api/videos/[id]/analyze/route.ts), so a card that
 * stops polling is a run that stops progressing.
 */
const POLL_MS = 5000;

function Chip({ label, tone }: { label: string; tone: string }) {
  return <span className={`badge tone-${tone}`}>{label}</span>;
}

/**
 * One match in the library: poster, title, status chips and the actions that
 * make sense for its current state. Owns its own polling while an analysis is
 * running so the rest of the page doesn't re-render on every tick.
 */
export function MatchCard({
  video,
  isOwner,
  onRemove,
}: {
  video: MatchVideo;
  isOwner: boolean;
  onRemove: (id: string) => void;
}) {
  const [status, setStatus] = useState<MatchStatus>(video.matchStatus);
  const [error, setError] = useState<string | null>(video.analysisError);
  const [busy, setBusy] = useState(false);
  /** Which half of a run we're in — the two take very different lengths of time,
   *  so saying which one is happening beats a bare "processing". */
  const [stage, setStage] = useState<"compressing" | "analysing" | "done">("analysing");
  const [, forceTick] = useState(0);
  /** Set only when *we* started the run, so elapsed time is never a guess. */
  const startedAt = useRef<number | null>(null);

  const active = status.analysis === "processing" || status.upload === "processing";

  // Poll while something is in flight. Advances the analysis state machine and
  // picks up an upload that finished processing.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/videos/${video.id}/analyze`);
        if (!res.ok || cancelled) return;
        const data = await res.json();
        setStatus((s) => ({ ...s, analysis: data.analysisStatus }));
        setError(data.analysisError ?? null);
        if (data.stage) setStage(data.stage);
        if (data.analysisStatus !== "processing") startedAt.current = null;
      } catch {
        // Transient — the next tick retries.
      }
      if (!cancelled) forceTick((n) => n + 1); // refresh the elapsed label
    };
    const id = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active, video.id]);

  const analyse = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${video.id}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        startedAt.current = Date.now();
        setStage(data.stage === "compressing" ? "compressing" : "analysing");
        setStatus((s) => ({ ...s, analysis: "processing" }));
      } else {
        setStatus((s) => ({ ...s, analysis: "failed" }));
        setError(data.error ?? "Couldn't start the AI breakdown.");
      }
    } finally {
      setBusy(false);
    }
  }, [video.id]);

  const activity = activityChip(status);
  const share = SHARE_CHIP[status.share];
  const elapsed = startedAt.current ? formatElapsed(Date.now() - startedAt.current) : null;

  return (
    <div className="card">
      <Link href={`/watch/${video.id}`} style={{ color: "inherit" }}>
        <div className="thumb">
          {video.thumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={video.thumbnailUrl}
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
        <Link
          href={`/watch/${video.id}`}
          style={{
            color: "inherit",
            fontWeight: 700,
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {video.title}
        </Link>

        <div className="muted mono" style={{ fontSize: 13, marginTop: 6 }}>
          {formatDate(video.createdAt)} · {formatDuration(video.durationS)} ·{" "}
          {formatSize(video.sizeBytes)}
          {video.addedVia === "share" && " · Added"}
          {video.addedVia === "participant" && " · Tagged"}
        </div>

        <div className="card-chips">
          {activity && <Chip label={activity.label} tone={activity.tone} />}
          <Chip label={share.label} tone={share.tone} />
        </div>

        {/* A TwelveLabs run reports no percentage, so this is deliberately an
            indeterminate bar with an honest "few minutes" expectation. */}
        {status.analysis === "processing" && (
          <div style={{ marginTop: 10 }}>
            <div className="progress indeterminate">
              <span />
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {stage === "compressing" ? "Compressing for analysis" : "Analysing rallies"}…
              {" this can take a few minutes."}
              {elapsed ? ` · ${elapsed}` : ""}
            </div>
          </div>
        )}

        {status.analysis === "failed" && error && (
          <div className="muted" style={{ fontSize: 12, marginTop: 8, color: "var(--danger)" }}>
            {error}
          </div>
        )}

        <div className="card-actions">
          <Link href={`/watch/${video.id}`} className="btn btn-sm">
            Watch
          </Link>

          {status.analysis === "ready" && (
            <Link href={`/watch/${video.id}`} className="btn secondary btn-sm">
              AI Breakdown
            </Link>
          )}
          {isOwner && status.analysis !== "ready" && (
            <button
              className="btn secondary btn-sm"
              onClick={analyse}
              disabled={busy || !canAnalyse(status)}
              title={
                status.upload !== "ready"
                  ? "Available once the match has finished uploading"
                  : undefined
              }
            >
              {status.analysis === "processing"
                ? "Analysing…"
                : status.analysis === "failed"
                  ? "Retry AI"
                  : "AI Breakdown"}
            </button>
          )}

          {status.upload === "ready" && (
            <ShareButton
              id={video.id}
              onShared={() =>
                setStatus((s) => (s.share === "private" ? { ...s, share: "link" } : s))
              }
            />
          )}

          {video.addedVia !== "upload" && (
            <button className="btn secondary btn-sm" onClick={() => onRemove(video.id)}>
              Remove
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
