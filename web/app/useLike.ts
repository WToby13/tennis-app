"use client";

import { useState } from "react";

/** Shared like state (optimistic) so a heart icon and a "N likes" line stay in sync. */
export function useLike(videoId: string, initialCount: number, initialLiked: boolean) {
  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (busy) return;
    setBusy(true);
    const next = !liked;
    setLiked(next);
    setCount((c) => c + (next ? 1 : -1));
    try {
      const res = await fetch(`/api/videos/${videoId}/like`, { method: next ? "POST" : "DELETE" });
      if (res.ok) {
        const d = await res.json();
        setLiked(d.likedByMe);
        setCount(d.count);
      } else {
        setLiked(!next);
        setCount((c) => c + (next ? -1 : 1));
      }
    } catch {
      setLiked(!next);
      setCount((c) => c + (next ? -1 : 1));
    } finally {
      setBusy(false);
    }
  }

  return { liked, count, busy, toggle };
}
