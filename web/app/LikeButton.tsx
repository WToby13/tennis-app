"use client";

import { useState } from "react";

/** Like / unlike a match; shows the current count. */
export function LikeButton({
  videoId,
  initialCount,
  initialLiked,
}: {
  videoId: string;
  initialCount: number;
  initialLiked: boolean;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    const method = liked ? "DELETE" : "POST";
    try {
      const res = await fetch(`/api/videos/${videoId}/like`, { method });
      if (res.ok) {
        const d = await res.json();
        setLiked(d.likedByMe);
        setCount(d.count);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={`chip like ${liked ? "liked" : ""}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={liked}
      title={liked ? "Unlike" : "Like"}
    >
      {liked ? "♥" : "♡"} {count}
    </button>
  );
}
