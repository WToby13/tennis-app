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
  /** Keyed by each definition id; each item has start_time/end_time + custom metadata. */
  result?: Record<string, AnalysisResultSegment[]>;
  error?: { message?: string } | string;
}

export interface AnalysisResultSegment {
  start_time: number;
  end_time: number;
  metadata?: Record<string, unknown>;
}

/**
 * Map a TwelveLabs result for one definition id into our VideoSegment shape.
 * Ignores the DB-only `id` field (assigned on insert).
 */
export function normalizeSegments(
  task: AnalysisTask,
  kind: string,
): Omit<VideoSegment, "id">[] {
  const raw = task.result?.[kind] ?? [];
  return raw.map((seg, i) => ({
    kind,
    idx: i,
    startS: seg.start_time,
    endS: seg.end_time,
    metadata: seg.metadata ?? {},
  }));
}
