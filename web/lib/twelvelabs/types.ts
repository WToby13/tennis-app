import type { VideoSegment } from "../metadata/types";

/**
 * Types for the TwelveLabs Analyze API (async, time_based_metadata mode with
 * segment_definitions). We hit the REST endpoints directly with fetch rather
 * than the SDK — the JSON bodies below are stable, the SDK method names have
 * drifted across versions. See https://docs.twelvelabs.io/docs/guides/segment-videos
 */

/** A single output field on a segment definition (name/type/description/enum). */
export interface SegmentField {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "array" | "timestamp";
  description: string;
  enum?: string[];
}

/** One kind of segment we ask Pegasus to produce (e.g. a tennis "rally"). */
export interface SegmentDefinition {
  /** Becomes the top-level key in the result (e.g. result.rally[]). */
  id: string;
  description: string;
  fields: SegmentField[];
}

/** The request body for POST /analyze/tasks. camelCase mirrors the REST params. */
export interface CreateAnalysisTaskBody {
  video: { type: "url"; url: string };
  model_name: "pegasus1.5";
  analysis_mode: "time_based_metadata";
  temperature: number;
  max_tokens: number;
  min_segment_duration: number;
  max_segment_duration: number;
  response_format: {
    type: "segment_definitions";
    segment_time_format: "seconds";
    segment_definitions: SegmentDefinition[];
  };
}

export type AnalysisTaskStatus = "queued" | "pending" | "processing" | "ready" | "failed";

/** Response from create + get task. `result` is populated once status is "ready". */
export interface AnalysisTask {
  task_id: string;
  status: AnalysisTaskStatus;
  /**
   * Where the segments live. For time_based_metadata the API returns
   * `result.data` as a JSON-ENCODED STRING that parses to an object keyed by
   * each segment definition id (e.g. { "rally": [ {start_time,end_time,metadata} ] }).
   * Typed loosely + normalized defensively so a minor API shape change doesn't
   * silently produce zero segments.
   */
  result?: unknown;
  error?: { message?: string } | string;
}

interface RawSegment {
  start_time?: number;
  end_time?: number;
  start?: number;
  end?: number;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const TIME_KEYS = new Set(["start_time", "end_time", "start", "end", "score", "confidence"]);

/**
 * Pull the segment array for `kind` out of a task result. Handles the documented
 * shape (`result.data` = JSON string → object keyed by definition id) plus a few
 * plausible variants (already-parsed object, a raw string, a flat array, or a
 * differently-named single array), so a wording change doesn't zero us out.
 */
function extractSegmentArray(result: unknown, kind: string): RawSegment[] {
  if (result == null) return [];
  let container: unknown = result;
  if (typeof result === "object" && "data" in (result as Record<string, unknown>)) {
    const d = (result as Record<string, unknown>).data;
    container = typeof d === "string" ? safeParse(d) : d;
  } else if (typeof result === "string") {
    container = safeParse(result);
  }
  if (container == null) return [];
  if (Array.isArray(container)) return container as RawSegment[];
  if (typeof container === "object") {
    const obj = container as Record<string, unknown>;
    if (Array.isArray(obj[kind])) return obj[kind] as RawSegment[];
    const firstArray = Object.values(obj).find((v) => Array.isArray(v));
    if (Array.isArray(firstArray)) return firstArray as RawSegment[];
  }
  return [];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Map a TwelveLabs result for one definition id into our VideoSegment shape.
 * Tolerant of start_time/start, end_time/end, and metadata nested-or-inline.
 * Ignores the DB-only `id` field (assigned on insert).
 */
export function normalizeSegments(task: AnalysisTask, kind: string): Omit<VideoSegment, "id">[] {
  return extractSegmentArray(task.result, kind).map((seg, i) => {
    const metadata =
      seg.metadata && typeof seg.metadata === "object"
        ? seg.metadata
        : Object.fromEntries(Object.entries(seg).filter(([k]) => !TIME_KEYS.has(k)));
    return {
      kind,
      idx: i,
      startS: num(seg.start_time ?? seg.start),
      endS: num(seg.end_time ?? seg.end),
      metadata,
    };
  });
}
