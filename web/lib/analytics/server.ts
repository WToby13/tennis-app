import { after } from "next/server";
import { config } from "../config";
import { getSupabaseServiceRole, serviceRoleConfigured } from "../supabase/service";
import type { EventInput } from "./events";

/**
 * Writing events.
 *
 * Two callers: `track()` below, used from API routes to record things the server
 * already knows for certain, and `/api/events`, which accepts them from the two
 * clients. Both land in the same table through `insertEvents`.
 *
 * Prefer instrumenting a route over instrumenting a component. A route event
 * cannot be blocked by an extension, cannot be double-fired by a re-render, and
 * cannot claim something that didn't happen — `upload_completed` written from
 * `POST /uploads/:id/complete` means the multipart upload genuinely assembled.
 * Client events are for the things only the client can see: a play button being
 * pressed, a sign-in wall being hit.
 */

/** A row as the table wants it. */
interface EventRow {
  occurred_at: string;
  user_id: string | null;
  anon_id: string | null;
  session_id: string | null;
  name: string;
  platform: string;
  app_version: string | null;
  video_id: string | null;
  props: Record<string, unknown>;
}

/** Events are never worth failing a request over, or delaying one. */
function analyticsEnabled(): boolean {
  return config.authEnabled && serviceRoleConfigured();
}

export async function insertEvents(rows: EventRow[]): Promise<void> {
  if (!rows.length || !analyticsEnabled()) return;
  try {
    const { error } = await getSupabaseServiceRole().from("events").insert(rows);
    if (error) console.error("[analytics] insert failed", error.message);
  } catch (err) {
    console.error("[analytics] insert threw", err);
  }
}

/** Trim anything that could be used to stuff the table via a public endpoint. */
export function clip(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export function toRow(
  input: EventInput,
  userId: string | null,
  occurredAt: string = new Date().toISOString(),
): EventRow {
  return {
    occurred_at: occurredAt,
    user_id: userId,
    anon_id: clip(input.anonId, 64),
    session_id: clip(input.sessionId, 64),
    name: input.name,
    platform: input.platform,
    app_version: clip(input.appVersion, 32),
    video_id: clip(input.videoId, 64),
    props: input.props && typeof input.props === "object" ? input.props : {},
  };
}

/**
 * Record a server-side event without making the caller wait for it.
 *
 * `after()` runs the work once the response has been flushed, which on Vercel is
 * the difference between "the insert happens" and "the function is frozen
 * mid-insert the moment the response returns". Do not replace this with a
 * floating promise.
 *
 * Deliberately `void` and deliberately swallows everything: no API route should
 * ever 500 because analytics had a bad day.
 */
export function track(
  name: EventInput["name"],
  opts: {
    userId: string | null;
    videoId?: string | null;
    props?: Record<string, unknown>;
    platform?: EventInput["platform"];
  },
): void {
  if (!analyticsEnabled()) return;
  try {
    const row = toRow(
      {
        name,
        // A route handler can't tell an iPhone from a browser reliably enough to
        // be worth guessing, and it doesn't matter for anything we ask: the
        // clients report their own platform on the events only they can send.
        platform: opts.platform ?? "web",
        videoId: opts.videoId ?? null,
        props: opts.props ?? {},
      },
      opts.userId,
    );
    after(() => insertEvents([row]));
  } catch (err) {
    // `after()` outside a request scope, most likely. Never the caller's problem.
    console.error("[analytics] track failed", err);
  }
}
