"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import { Avatar } from "../../Avatar";
import { FollowButton } from "../../FollowButton";
import { formatDate, formatDuration, STATUS_LABEL } from "@/lib/matchFormat";

interface ProfileVideo {
  id: string;
  title: string;
  status: "uploading" | "processing" | "ready" | "failed";
  durationS: number | null;
  createdAt: string;
  thumbnailUrl: string | null;
}

interface ProfileData {
  profile: { id: string; displayName: string; followers: number; following: number; isFollowing: boolean };
  videos: ProfileVideo[];
  isSelf: boolean;
}

export default function PublicProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<ProfileData | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch(`/api/users/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setNotFound(true));
  }, [id]);

  if (notFound) return <p className="muted">This player couldn’t be found.</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const { profile, videos, isSelf } = data;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <Avatar name={profile.displayName} size={64} />
        <div style={{ flex: 1 }}>
          <h1 style={{ marginBottom: 2 }}>{profile.displayName}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            <b className="mono">{profile.followers}</b> followers ·{" "}
            <b className="mono">{profile.following}</b> following
          </p>
        </div>
        {isSelf ? (
          <Link href="/matches?edit=profile" className="btn secondary">
            Edit profile
          </Link>
        ) : (
          <FollowButton userId={profile.id} initialFollowing={profile.isFollowing} />
        )}
      </div>

      <h2 style={{ fontSize: 16, margin: "28px 0 14px" }}>Matches</h2>
      {videos.length === 0 && <p className="muted">No matches to show.</p>}

      {videos.length > 0 && (
        <div className="grid">
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
                    style={{ color: "inherit", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {v.title}
                  </Link>
                  <span className={`badge ${v.status}`}>{STATUS_LABEL[v.status]}</span>
                </div>
                <div className="muted mono" style={{ fontSize: 13, marginTop: 6 }}>
                  {formatDate(v.createdAt)} · {formatDuration(v.durationS)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
