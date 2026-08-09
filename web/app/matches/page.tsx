"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Avatar } from "../Avatar";
import { EditProfile, type AccountFields } from "../EditProfile";
import { MatchCard } from "../MatchCard";
import { UploadTile } from "../UploadTile";
import { config } from "@/lib/config";
import type { MatchVideo } from "@/lib/matchFormat";

interface Profile {
  id: string;
  displayName: string;
  followers: number;
  following: number;
}

/**
 * The library — profile, uploading and your matches on one page.
 *
 * This replaces the old /matches + /profile + /upload trio; those routes now
 * redirect here. Profile editing is a modal (`?edit=profile` opens it, which is
 * where the OAuth callback sends first-time users to set their playing hand).
 */
function LibraryPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [videos, setVideos] = useState<MatchVideo[] | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountFields | null>(null);
  const [editing, setEditing] = useState(params.get("edit") === "profile");

  const loadVideos = useCallback(async () => {
    const res = await fetch("/api/videos");
    if (!res.ok) {
      setVideos([]);
      return;
    }
    const { videos } = await res.json();
    setVideos(videos);
  }, []);

  useEffect(() => {
    loadVideos().catch(() => setVideos([]));
  }, [loadVideos]);

  useEffect(() => {
    if (!config.authEnabled) return;
    (async () => {
      const res = await fetch("/api/users/me");
      if (!res.ok) return;
      const data = await res.json();
      setProfile(data.profile);
      if (data.account) setAccount(data.account);
    })();
  }, []);

  /** Drop a shared video from my library (does not delete the original). */
  const removeFromLibrary = useCallback(async (id: string) => {
    setVideos((vs) => (vs ?? []).filter((v) => v.id !== id));
    await fetch(`/api/videos/${id}/library`, { method: "DELETE" }).catch(() => {});
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(false);
    // Drop ?edit=profile so a refresh doesn't reopen the modal.
    if (params.get("edit")) router.replace("/matches");
  }, [params, router]);

  return (
    <div>
      <div className="library-header">
        {/* No avatar in local no-auth mode — there's no one to be. */}
        {profile && <Avatar name={profile.displayName} size={56} />}
        <div className="who">
          <h1 style={{ marginBottom: 2 }}>{profile?.displayName ?? "Your matches"}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {profile ? (
              <>
                <b className="mono">{profile.followers}</b> followers ·{" "}
                <b className="mono">{profile.following}</b> following
                {account?.email ? ` · ${account.email}` : ""}
              </>
            ) : (
              "Your library — only you can see these unless you share them."
            )}
          </p>
        </div>
        {profile && (
          <div style={{ display: "flex", gap: 8 }}>
            <Link href={`/u/${profile.id}`} className="btn secondary btn-sm">
              Public profile
            </Link>
            {account && (
              <button className="btn secondary btn-sm" onClick={() => setEditing(true)}>
                Edit profile
              </button>
            )}
          </div>
        )}
      </div>

      {videos === null ? (
        <p className="muted" style={{ marginTop: 24 }}>
          Loading…
        </p>
      ) : (
        <div className="grid" style={{ marginTop: 24 }}>
          <UploadTile onUploaded={loadVideos} />
          {videos.map((v) => (
            <MatchCard
              key={v.id}
              video={v}
              isOwner={!profile || v.ownerId === profile.id}
              onRemove={removeFromLibrary}
            />
          ))}
        </div>
      )}

      {videos?.length === 0 && (
        <p className="muted" style={{ marginTop: 20, fontSize: 14 }}>
          No matches yet — record one in the iPhone app, or upload a file above.
        </p>
      )}

      {editing && account && profile && (
        <EditProfile
          userId={profile.id}
          initial={account}
          onClose={closeEditor}
          onSaved={(fields) => {
            setAccount(fields);
            setProfile((p) => (p ? { ...p, displayName: fields.displayName } : p));
            closeEditor();
          }}
        />
      )}
    </div>
  );
}

export default function MatchesPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LibraryPage />
    </Suspense>
  );
}
