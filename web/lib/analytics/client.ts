"use client";

import type { EventName } from "./events";

/**
 * Browser-side events: the handful of things the server can't see.
 *
 * Most of what we measure is written from API routes (lib/analytics/server.ts),
 * which is more truthful and can't be blocked. This file covers what only the
 * browser knows — a play button being pressed, a signed-out visitor hitting the
 * sign-in wall, a share link being opened at all.
 *
 * ── Why sessionStorage and not a cookie ──────────────────────────────────────
 *
 * Under PECR, storing anything on someone's device that isn't strictly
 * necessary needs consent, and analytics is not strictly necessary — so a
 * persistent, cross-visit identifier would mean a consent banner. sessionStorage
 * is cleared when the tab closes, which keeps the identifier scoped to the visit
 * rather than to the person, and keeps us out of banner territory on the
 * defensible reading of the rules.
 *
 * The cost is real and worth stating: an anonymous visitor who opens a share
 * link, closes the tab, and signs up tomorrow is counted as two people, so
 * `metrics_share_conversion` under-reports. The path we care about most —
 * open link → hit the wall → sign up — happens in one tab session, so the main
 * funnel survives. If cross-visit attribution ever matters more than the banner
 * costs, that's the trade to revisit, and it is a legal decision as much as a
 * technical one.
 *
 * The opt-out flag is the one thing kept in localStorage: honouring a choice
 * someone made *is* strictly necessary, and it would be perverse to forget it
 * when the tab closes.
 */

const ANON_KEY = "ojo_anon_id";
const SESSION_KEY = "ojo_session_id";
const OPT_OUT_KEY = "ojo_analytics_opt_out";
const ENDPOINT = "/api/events";

/** Fired often enough to batch, rarely enough that 3s is imperceptible. */
const FLUSH_DELAY_MS = 3000;
const MAX_QUEUE = 20;

type Queued = {
  name: EventName;
  platform: "web";
  anonId: string | null;
  sessionId: string | null;
  videoId: string | null;
  occurredAt: string;
  props: Record<string, unknown>;
};

let queue: Queued[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function browser(): boolean {
  return typeof window !== "undefined";
}

/** UK GDPR Article 21 gives a right to object to processing under legitimate
 *  interests, which is the basis /privacy claims for this. So it has to work. */
export function hasOptedOut(): boolean {
  if (!browser()) return true;
  try {
    return window.localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    // Storage blocked entirely (private mode, hardened settings). Treat an
    // unreadable preference as "don't measure me" rather than guessing.
    return true;
  }
}

export function setOptedOut(optedOut: boolean): void {
  if (!browser()) return;
  try {
    if (optedOut) {
      window.localStorage.setItem(OPT_OUT_KEY, "1");
      // Drop anything already queued and forget the ids — opting out should not
      // leave the last few minutes to be sent anyway.
      queue = [];
      window.sessionStorage.removeItem(ANON_KEY);
      window.sessionStorage.removeItem(SESSION_KEY);
    } else {
      window.localStorage.removeItem(OPT_OUT_KEY);
    }
  } catch {
    // Nothing sensible to do; the getter fails closed.
  }
}

function id(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function stored(key: string): string | null {
  if (!browser()) return null;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const fresh = id();
    window.sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return null;
  }
}

/** Exposed so the sign-up form can carry it through to `signup_completed`. */
export function anonId(): string | null {
  return hasOptedOut() ? null : stored(ANON_KEY);
}

function sessionId(): string | null {
  return stored(SESSION_KEY);
}

function send(events: Queued[], beacon: boolean): void {
  if (!events.length) return;
  const payload = JSON.stringify({ events });
  // On unload only sendBeacon is guaranteed to survive the navigation; fetch
  // with keepalive is the fallback for browsers that have it disabled.
  if (beacon && typeof navigator?.sendBeacon === "function") {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon(ENDPOINT, blob)) return;
  }
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // A dropped analytics event is not worth telling anyone about.
  });
}

export function flush(beacon = false): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const batch = queue;
  queue = [];
  send(batch, beacon);
}

/** Flush whatever is queued when the tab is hidden or closed. */
function listen(): void {
  if (listening || !browser()) return;
  listening = true;
  // `visibilitychange` → hidden is the one event that reliably fires on mobile
  // Safari when the app is swiped away; `pagehide` covers bfcache navigations.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush(true);
  });
  window.addEventListener("pagehide", () => flush(true));
}

/**
 * Queue an event. Cheap, never throws, and a no-op for anyone who has opted out.
 *
 * Pass `now: true` for something the user might navigate away from immediately
 * (a share, a sign-up) — otherwise it goes out with the next batch.
 */
export function track(
  name: EventName,
  props: Record<string, unknown> = {},
  opts: { videoId?: string | null; now?: boolean } = {},
): void {
  if (!browser() || hasOptedOut()) return;
  listen();

  queue.push({
    name,
    platform: "web",
    anonId: anonId(),
    sessionId: sessionId(),
    videoId: opts.videoId ?? null,
    occurredAt: new Date().toISOString(),
    props,
  });

  if (opts.now || queue.length >= MAX_QUEUE) {
    flush();
    return;
  }
  if (!timer) timer = setTimeout(() => flush(), FLUSH_DELAY_MS);
}
