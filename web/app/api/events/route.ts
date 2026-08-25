import { config } from "@/lib/config";
import { isEventName } from "@/lib/analytics/events";
import type { EventInput } from "@/lib/analytics/events";
import { clip, insertEvents, toRow } from "@/lib/analytics/server";
import { getRequestUserId, getSupabaseServer } from "@/lib/supabase/server";
import { badRequest, json } from "@/lib/util";

export const runtime = "nodejs";

/**
 * Product-event ingest for both clients.
 *
 * This is a **public** endpoint (see `publicPrefixes` in middleware.ts) and it
 * has to be: the highest-value row in the whole funnel is written by someone who
 * does not have an account yet — the person who just opened a share link. So it
 * is written defensively:
 *
 *   - `user_id` comes from the verified session, never the body. A caller cannot
 *     attribute events to another account.
 *   - Event names are allow-listed against lib/analytics/events.ts.
 *   - `props` is flattened to primitives and capped, so it can't be used as free
 *     storage and can't accidentally carry a nested object full of PII.
 *   - Timestamps are clamped, so a buffered offline batch can be backdated a
 *     little but history can't be rewritten.
 *   - A crude per-instance rate limit blunts a naive loop.
 *
 * It always answers cheaply and never makes the client's life difficult: bad
 * events are dropped and counted rather than 400'd, because the callers are
 * `sendBeacon` and a background flush that must not retry into a storm.
 */

const MAX_BATCH = 20;
const MAX_PROP_KEYS = 12;
const MAX_PROP_STRING = 200;
/** How far back a buffered event may claim to be. iOS flushes on next launch. */
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-instance sliding window. Serverless means each instance has its own copy
 * and a cold start resets it, so this is a speed bump and not a real limiter —
 * enough to stop a loop in a browser console, not enough to stop someone who
 * means it. If that ever matters, move it to Postgres or a Vercel KV counter.
 */
const RATE_LIMIT = { events: 120, windowMs: 60_000 };
const seen = new Map<string, { count: number; resetAt: number }>();

function rateLimited(key: string, cost: number): boolean {
  const now = Date.now();
  const entry = seen.get(key);
  if (!entry || now > entry.resetAt) {
    seen.set(key, { count: cost, resetAt: now + RATE_LIMIT.windowMs });
    // Opportunistic sweep so the map can't grow without bound on a warm instance.
    if (seen.size > 5_000) {
      for (const [k, v] of seen) if (now > v.resetAt) seen.delete(k);
    }
    return false;
  }
  entry.count += cost;
  return entry.count > RATE_LIMIT.events;
}

/** Primitives only, capped in count and length. Anything else is dropped. */
function sanitizeProps(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_PROP_KEYS) break;
    if (key.length > 40) continue;
    if (typeof value === "string") out[key] = value.slice(0, MAX_PROP_STRING);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean" || value === null) out[key] = value;
    // Objects, arrays and functions are deliberately not carried through.
  }
  return out;
}

/** Clamp a client timestamp into [now - 7d, now]. Clock skew is real. */
function occurredAt(raw: unknown): string {
  const now = Date.now();
  if (typeof raw !== "string") return new Date(now).toISOString();
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return new Date(now).toISOString();
  return new Date(Math.min(now, Math.max(now - MAX_BACKDATE_MS, parsed))).toISOString();
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  // Accepts a batch or a single event, so `sendBeacon` and a one-off call look
  // the same to the caller.
  const incoming: unknown[] = Array.isArray(body?.events)
    ? body.events
    : body && typeof body === "object"
      ? [body]
      : [];
  if (!incoming.length) return badRequest("events is required");

  const batch = incoming.slice(0, MAX_BATCH);

  // Local no-auth dev mode has no Supabase to write to. Accept and discard, so
  // the clients behave identically and dev doesn't fill with errors.
  if (!config.authEnabled) return json({ accepted: 0, dropped: batch.length }, { status: 202 });

  const supabase = await getSupabaseServer();
  const userId = await getRequestUserId(supabase);

  const rows = [];
  let dropped = 0;
  for (const raw of batch) {
    const event = raw as Partial<EventInput> & Record<string, unknown>;
    if (!isEventName(event?.name) || (event.platform !== "web" && event.platform !== "ios")) {
      dropped++;
      continue;
    }
    rows.push(
      toRow(
        {
          name: event.name,
          platform: event.platform,
          anonId: clip(event.anonId, 64),
          sessionId: clip(event.sessionId, 64),
          videoId: clip(event.videoId, 64),
          appVersion: clip(event.appVersion, 32),
          props: sanitizeProps(event.props),
        },
        userId,
        occurredAt(event.occurredAt),
      ),
    );
  }

  // Keyed by account where there is one, so a shared IP behind club Wi-Fi
  // doesn't rate-limit everybody at once.
  const key = userId ?? clip(rows[0]?.anon_id, 64) ?? "anonymous";
  if (rateLimited(key, rows.length || 1)) {
    return json({ accepted: 0, dropped: batch.length }, { status: 429 });
  }

  await insertEvents(rows);
  return json({ accepted: rows.length, dropped }, { status: 202 });
}
