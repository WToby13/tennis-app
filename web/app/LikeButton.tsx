"use client";

import { HeartIcon } from "./icons";
import { useLike } from "./useLike";

/** Like control for the watch header: an outline button with heart + count. */
export function LikeButton({
  videoId,
  initialCount,
  initialLiked,
}: {
  videoId: string;
  initialCount: number;
  initialLiked: boolean;
}) {
  const { liked, count, busy, toggle } = useLike(videoId, initialCount, initialLiked);
  return (
    <button
      className={`btn secondary ${liked ? "on" : ""}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={liked}
    >
      <span style={{ display: "inline-flex", color: liked ? "var(--danger)" : "inherit" }}>
        <HeartIcon size={18} filled={liked} />
      </span>
      {count}
    </button>
  );
}
