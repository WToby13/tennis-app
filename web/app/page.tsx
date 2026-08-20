"use client";

import { useEffect, useState } from "react";
import { FeedCard, type FeedItem } from "./FeedCard";
import { PeopleSearch } from "./PeopleSearch";
import { MatchGridSkeleton } from "./Skeleton";

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  /** Matches hidden client-side after blocking their poster. */
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    fetch("/api/feed")
      .then((r) => r.json())
      .then((d) => {
        setFeed(d.feed);
        setViewerId(d.viewerId ?? null);
      })
      .catch(() => setFeed([]));
  }, []);

  const visible = feed?.filter((i) => !hidden.includes(i.id)) ?? null;

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        For you
      </div>
      <h1 style={{ marginBottom: 6 }}>Latest matches</h1>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Matches from players you follow, and your own.
      </p>

      {visible === null && <MatchGridSkeleton count={3} />}

      {visible?.length === 0 && (
        <div className="feed">
          <div className="card" style={{ padding: 32, textAlign: "center" }}>
            <p className="muted" style={{ marginBottom: 16 }}>
              Your feed is empty. Follow players to see their matches here — or record and upload
              your own.
            </p>
            <PeopleSearch />
          </div>
        </div>
      )}

      {visible && visible.length > 0 && (
        <div className="feed">
          {visible.map((item) => (
            <FeedCard
              key={item.id}
              item={item}
              viewerId={viewerId}
              onBlocked={() =>
                setHidden((h) =>
                  // Blocking removes everything by that poster, not just this card.
                  h.concat((feed ?? []).filter((i) => i.ownerId === item.ownerId).map((i) => i.id)),
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
