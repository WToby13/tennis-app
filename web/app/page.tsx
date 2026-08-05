"use client";

import { useEffect, useState } from "react";
import { FeedCard, type FeedItem } from "./FeedCard";
import { PeopleSearch } from "./PeopleSearch";

export default function FeedPage() {
  const [feed, setFeed] = useState<FeedItem[] | null>(null);

  useEffect(() => {
    fetch("/api/feed")
      .then((r) => r.json())
      .then((d) => setFeed(d.feed))
      .catch(() => setFeed([]));
  }, []);

  return (
    <div>
      <div className="eyebrow" style={{ marginBottom: 8 }}>
        For you
      </div>
      <h1 style={{ marginBottom: 6 }}>Latest matches</h1>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        Matches from players you follow, and your own.
      </p>

      {feed === null && (
        <p className="muted" style={{ marginTop: 20 }}>
          Loading…
        </p>
      )}

      {feed?.length === 0 && (
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

      {feed && feed.length > 0 && (
        <div className="feed">
          {feed.map((item) => (
            <FeedCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
