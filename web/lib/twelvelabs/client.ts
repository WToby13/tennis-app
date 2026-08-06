import { config } from "../config";
import type { AnalysisTask, CreateAnalysisTaskBody } from "./types";

/**
 * Thin TwelveLabs REST client. Mirrors lib/email/send.ts: a single choke point,
 * raw fetch, and a clear "not configured" signal when the key is unset so callers
 * (and local dev) degrade gracefully instead of throwing opaque errors.
 *
 * Auth is a plain `x-api-key` header (not Bearer). Base URL from config.
 */
export class TwelveLabsNotConfiguredError extends Error {
  constructor() {
    super("TWELVELABS_API_KEY is not set");
    this.name = "TwelveLabsNotConfiguredError";
  }
}

export const twelvelabsEnabled = () => config.twelvelabs.enabled;

async function tlFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!config.twelvelabs.enabled) throw new TwelveLabsNotConfiguredError();
  return fetch(`${config.twelvelabs.baseUrl}${path}`, {
    ...init,
    headers: {
      "x-api-key": config.twelvelabs.apiKey,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** An HTTP error from TwelveLabs, carrying their machine-readable `code` when present. */
export class TwelveLabsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "TwelveLabsApiError";
  }
}

/** Kick off an async analysis task. Returns the task handle (task_id + status). */
export async function createAnalysisTask(body: CreateAnalysisTaskBody): Promise<AnalysisTask> {
  const res = await tlFetch("/analyze/tasks", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    let code: string | undefined;
    let apiMessage: string | undefined;
    try {
      const parsed = JSON.parse(detail) as { code?: string; message?: string };
      code = parsed.code;
      apiMessage = parsed.message;
    } catch {
      // non-JSON body; fall back to the raw text below
    }
    throw new TwelveLabsApiError(
      apiMessage || `TwelveLabs create task failed (${res.status}): ${detail}`,
      res.status,
      code,
    );
  }
  const raw = (await res.json()) as AnalysisTask & { _id?: string; id?: string };
  // Different endpoints/versions name the id task_id / _id / id — capture whichever.
  if (!raw.task_id) raw.task_id = raw._id ?? raw.id ?? "";
  return raw;
}

/** Poll a task's current status/result. */
export async function getAnalysisTask(taskId: string): Promise<AnalysisTask> {
  const res = await tlFetch(`/analyze/tasks/${encodeURIComponent(taskId)}`, { method: "GET" });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`TwelveLabs get task failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as AnalysisTask;
}
