import { randomBytes } from "node:crypto";
import type { AnalysisPlayers } from "./metadata/types";

/** Normalize a `{player_1, player_2}` name input → trimmed strings or null. */
export function sanitizePlayers(raw: unknown): AnalysisPlayers | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);
  return { player_1: clean(r.player_1), player_2: clean(r.player_2) };
}

/** A URL-safe, unguessable share token (~24 chars). */
export function randomToken(): string {
  return randomBytes(18).toString("base64url");
}

export function extForContentType(contentType: string): string {
  switch (contentType) {
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "video/webm":
      return "webm";
    default:
      return "bin";
  }
}

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found"): Response {
  return json({ error: message }, { status: 404 });
}
