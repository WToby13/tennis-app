"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { Avatar } from "../Avatar";
import { EditProfile, type AccountFields } from "../EditProfile";
import { MatchCard } from "../MatchCard";
import { UploadTile } from "../UploadTile";
import type { MatchVideo } from "@/lib/matchFormat";
import { getSupabaseBrowser } from "@/lib/supabase/client";

export interface LibraryProfile {
  id: string;
  displayName: string;
  followers: number;
  following: number;
}

/**
 * The library's interactive half. Everything it first renders is handed to it by
 * the server component in `page.tsx`, so the initial paint has real content —
 * this only re-fetches after something changes (an upload, a removal).
 */
export function Library({
  initialVideos,
  profile: initialProfile,
  account,
  openEditor,
}: {
  initialVideos: MatchVideo[];
  profile: LibraryProfile | null;
  account: AccountFields | null;
  openEditor: boolean;
}) {
  const router = useRouter();
  const [videos, setVideos] = useState(initialVideos);
  const [profile, setProfile] = useState(initialProfile);
  const [fields, setFields] = useState(account);
  const [editing, setEditing] = useState(openEditor);

  const reload = useCallback(async () => {
    const res = await fetch("/api/videos");
    if (!res.ok) return;
    setVideos((await res.json()).videos);
  }, []);

  /** Drop a shared video from my library (does not delete the original). */
  const removeFromLibrary = useCallback(async (id: string) => {
    setVideos((vs) => vs.filter((v) => v.id !== id));
    await fetch(`/api/videos/${id}/library`, { method: "DELETE" }).catch(() => {});
  }, []);

  const signOut = useCallback(async () => {
    await getSupabaseBrowser().auth.signOut();
    window.location.href = "/landing";
  }, []);

  const closeEditor = useCallback(() => {
    setEditing(false);
    // Drop ?edit=profile so a refresh doesn't reopen the modal.
    if (openEditor) router.replace("/matches");
  }, [openEditor, router]);

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
                {fields?.email ? ` · ${fields.email}` : ""}
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
            {fields && (
              <button className="btn secondary btn-sm" onClick={() => setEditing(true)}>
                Edit profile
              </button>
            )}
            {/* Signing out was only reachable from inside the profile modal. */}
            <button className="btn secondary btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        )}
      </div>

      <div className="grid" style={{ marginTop: 24 }}>
        <UploadTile onUploaded={reload} />
        {videos.map((v) => (
          <MatchCard
            key={v.id}
            video={v}
            isOwner={!profile || v.ownerId === profile.id}
            onRemove={removeFromLibrary}
          />
        ))}
      </div>

      {videos.length === 0 && (
        <p className="muted" style={{ marginTop: 20, fontSize: 14 }}>
          No matches yet — record one in the iPhone app, or upload a file above.
        </p>
      )}

      {editing && fields && profile && (
        <EditProfile
          userId={profile.id}
          initial={fields}
          onClose={closeEditor}
          onSaved={(next) => {
            setFields(next);
            setProfile((p) => (p ? { ...p, displayName: next.displayName } : p));
            closeEditor();
          }}
        />
      )}
    </div>
  );
}
