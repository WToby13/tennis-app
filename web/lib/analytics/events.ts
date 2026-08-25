/**
 * The event vocabulary. One list, shared by the web client, the API routes and
 * (by hand — Swift can't import this) `ios/Ojo/Ojo/Analytics.swift`.
 *
 * `/api/events` is a public endpoint, so this doubles as its allow-list:
 * anything not named here is dropped. Keep it short. Every event should be one
 * somebody can point at a line in docs/GTM.md §6 and say which number it feeds;
 * an event nobody reads is a row we are storing about a person for no reason.
 */
export const EVENT_NAMES = [
  // --- The loop: record → share → recipient signs up → recipient records ---
  /** A recording finished on the phone. Not the same as an upload starting. */
  "recording_finished",
  /** Multipart upload created. Denominator for upload reliability. */
  "upload_started",
  /** Bytes are all in and the match is playable. Denominator for share rate. */
  "upload_completed",
  /** The upload gave up. `props.reason`, `props.partRetries`. */
  "upload_failed",
  /** A match was shared. `props.channel`: link | followers | invite. */
  "match_shared",
  /** Someone opened a /watch link carrying a share token. */
  "share_link_opened",
  /** A signed-out visitor was bounced to /sign-in from a share link (GTM #2). */
  "sign_in_wall_hit",
  /** Reached the sign-up form. */
  "signup_started",
  /** Account created. Stitched to `share_link_opened` by anon_id. */
  "signup_completed",
  /** Returning sign-in, so signups aren't inflated by them. */
  "sign_in",
  /** A shared match was added to the viewer's own library. */
  "library_add",

  // --- Was it any good? ---
  /** Playback actually started (a real play, not a page load). */
  "watch_started",
  /** Left the match. `props.watchedSeconds`, `props.durationS`. */
  "watch_ended",

  // --- AI breakdown ---
  "analysis_started",
  "analysis_ready",
  "analysis_failed",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const ALLOWED = new Set<string>(EVENT_NAMES);

export function isEventName(value: unknown): value is EventName {
  return typeof value === "string" && ALLOWED.has(value);
}

export type Platform = "web" | "ios";

/** One event as a client sends it. `userId` is deliberately absent — see below. */
export interface EventInput {
  name: EventName;
  platform: Platform;
  /** Client-minted, per browser-tab / app session. A session is a group-by, not a table. */
  sessionId?: string | null;
  /** Anonymous id for someone with no account yet. Never persisted past the session. */
  anonId?: string | null;
  videoId?: string | null;
  appVersion?: string | null;
  /** ISO timestamp. Present when an event was buffered offline and sent later. */
  occurredAt?: string | null;
  props?: Record<string, unknown> | null;
}

/**
 * There is no `userId` on the wire in either direction, and that is the point:
 * `/api/events` stamps it from the session the middleware already verified, so a
 * client cannot attribute its events to somebody else. Same reasoning as
 * VERIFIED_USER_HEADER in lib/supabase/server.ts.
 */
