"use client";

import { useState } from "react";

/** Follow / unfollow a user; optimistic, self-contained. */
export function FollowButton({
  userId,
  initialFollowing,
  size = "md",
}: {
  userId: string;
  initialFollowing: boolean;
  size?: "sm" | "md";
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const method = following ? "DELETE" : "POST";
    try {
      const res = await fetch(`/api/users/${userId}/follow`, { method });
      if (res.ok) setFollowing((await res.json()).following);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`btn ${following ? "secondary" : ""} ${size === "sm" ? "btn-sm" : ""}`}
      onClick={toggle}
      disabled={busy}
    >
      {following ? "Following" : "Follow"}
    </button>
  );
}
