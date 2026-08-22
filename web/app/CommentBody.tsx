"use client";

import Link from "next/link";
import { parseComment } from "@/lib/comments";

/**
 * A comment body with its two live bits rendered: tagged players link to their
 * profile, and a timestamp links into the match.
 *
 * `onSeek` is what separates the watch page from everywhere else. On the watch
 * page there is a player sitting above the comment, so a timestamp jumps it and
 * starts playing; in a feed card or an inbox there is nothing to seek, so the
 * same timestamp becomes a link to the match at that moment instead.
 */
export function CommentBody({
  body,
  videoId,
  onSeek,
}: {
  body: string;
  videoId?: string;
  onSeek?: (seconds: number) => void;
}) {
  return (
    <>
      {parseComment(body).map((token, i) => {
        if (token.type === "text") return <span key={i}>{token.text}</span>;

        if (token.type === "mention") {
          return (
            <Link key={i} href={`/u/${token.userId}`} className="mention">
              @{token.text}
            </Link>
          );
        }

        if (onSeek) {
          return (
            <button
              key={i}
              type="button"
              className="ts-link"
              onClick={() => onSeek(token.seconds)}
              title={`Play from ${token.text}`}
            >
              {token.text}
            </button>
          );
        }

        return videoId ? (
          <Link key={i} href={`/watch/${videoId}?t=${token.seconds}`} className="ts-link">
            {token.text}
          </Link>
        ) : (
          <span key={i} className="ts-link">
            {token.text}
          </span>
        );
      })}
    </>
  );
}
