/**
 * The little markup language a match comment is written in.
 *
 * Two things inside a comment body mean more than their own text:
 *
 *   `@[Ada Lovelace](3f0c…-…)`  a tagged player
 *   `12:34`                      a moment in the match
 *
 * Mentions carry the user's id inline rather than being matched by name after
 * the fact. Names are not unique and they change; an id written at the time the
 * comment was posted keeps pointing at the person who was actually tagged. It
 * is also what the notification trigger reads (see
 * `supabase/migrations/0017_notifications.sql`) — the same regex, on the
 * database side.
 *
 * Timestamps are plain text on purpose. People already type "watch 1:12" without
 * being asked, and asking them to pick from a menu to make it a link would be
 * worse than recognising what they wrote.
 *
 * Shared by the web components and mirrored in `ios/Ojo/Ojo/CommentText.swift`.
 */

/** `@[Display Name](uuid)` — the uuid matched in full canonical form. */
export const MENTION_RE =
  /@\[([^\]]{1,80})\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/**
 * `m:ss` or `h:mm:ss`, not glued to a surrounding word or digit.
 *
 * The lookarounds matter more than they look: without them "10:30am" reads as a
 * seek to ten and a half minutes, and a set score written "6:4" is close enough
 * to a timestamp that the seconds group has to be two digits to keep them apart.
 */
export const TIMESTAMP_RE = /(?<![\w:])(\d{1,2}:[0-5]\d(?::[0-5]\d)?)(?![\w:])/g;

export type CommentToken =
  | { type: "text"; text: string }
  | { type: "mention"; text: string; userId: string }
  | { type: "timestamp"; text: string; seconds: number };

/** Seconds from an `m:ss` / `h:mm:ss` label. */
export function parseTimestamp(label: string): number {
  const parts = label.split(":").map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

/** `m:ss`, or `h:mm:ss` past the hour — matches the player's own clock. */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The plain text of a comment, with mention markup reduced to `@Name`. */
export function commentPlainText(body: string): string {
  return body.replace(MENTION_RE, (_all, name: string) => `@${name}`);
}

/**
 * Split a body into renderable runs.
 *
 * Mentions are found first and their inner text is never re-scanned, so a player
 * unlucky enough to be called "12:34" does not turn their own tag into a seek
 * link.
 */
export function parseComment(body: string): CommentToken[] {
  const out: CommentToken[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    if (!text) return;
    let last = 0;
    for (const m of text.matchAll(TIMESTAMP_RE)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ type: "text", text: text.slice(last, at) });
      out.push({ type: "timestamp", text: m[1], seconds: parseTimestamp(m[1]) });
      last = at + m[1].length;
    }
    if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  };

  for (const m of body.matchAll(MENTION_RE)) {
    const at = m.index ?? 0;
    pushText(body.slice(cursor, at));
    out.push({ type: "mention", text: m[1], userId: m[2] });
    cursor = at + m[0].length;
  }
  pushText(body.slice(cursor));
  return out;
}

/** How a picked player is written into a draft. */
export function mentionMarkup(displayName: string, userId: string): string {
  // A `]` inside the name would end the label early and leave the rest as loose
  // text, so it is the one character that cannot survive as-is.
  return `@[${displayName.replace(/[[\]]/g, "").slice(0, 80)}](${userId})`;
}
