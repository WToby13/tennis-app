"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { FollowButton } from "./FollowButton";

/** Find players by name and follow them. Reuses the /api/users typeahead. */
export function PeopleSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; displayName: string }[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(query.trim())}`);
        if (res.ok) setResults((await res.json()).users ?? []);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  return (
    <div style={{ maxWidth: 420, margin: "0 auto", textAlign: "left" }}>
      <input
        type="text"
        placeholder="Search players by name…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {results.map((u) => (
        <div key={u.id} className="people-row">
          <Link href={`/u/${u.id}`} className="people-row-name">
            <Avatar name={u.displayName} size={34} />
            <span>{u.displayName}</span>
          </Link>
          <FollowButton userId={u.id} initialFollowing={false} size="sm" />
        </div>
      ))}
    </div>
  );
}
