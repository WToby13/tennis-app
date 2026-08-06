import type { CreateAnalysisTaskBody, SegmentDefinition } from "./types";

/**
 * Admin-managed analysis config. Everything a user would see in the "Advanced
 * Settings" panel lives here as code today (an admin UI can edit it later). The
 * user just presses a button; these presets + the rally definition drive the run.
 *
 * These map 1:1 to the TwelveLabs Analyze params (Pegasus 1.5, time_based_metadata).
 */
export const RALLY_KIND = "rally";

/** Preset params — mirror the "Advanced Settings" screenshot. */
const PRESET = {
  model_name: "pegasus1.5",
  analysis_mode: "time_based_metadata",
  temperature: 0.2,
  max_tokens: 98304,
  min_segment_duration: 2,
  max_segment_duration: 20,
} as const;

/**
 * Optional per-match context an admin/user could supply later to sharpen the
 * analysis (who's on each side, handedness). Injected into field descriptions.
 * v1 ships no UI for this — it's the designed extension point.
 */
export interface RallyContext {
  nearSidePlayer?: string;
  farSidePlayer?: string;
  /** Handedness hints, keyed loosely by side or name — free-form, appended to the prompt. */
  notes?: string;
}

/** Toby's rally definition. Kept verbatim so the admin config is the source of truth. */
function rallyDefinition(context?: RallyContext): SegmentDefinition {
  const nearHint = context?.nearSidePlayer ? ` The near_bottom player is ${context.nearSidePlayer}.` : "";
  const farHint = context?.farSidePlayer ? ` The far_top player is ${context.farSidePlayer}.` : "";
  const notes = context?.notes ? ` ${context.notes}` : "";

  return {
    id: RALLY_KIND,
    description:
      "Create one segment for each point that is played. Here is exactly what a point looks like in this video. A POINT BEGINS when one player stands near the white line at the far back edge of their side (the line nearest the BOTTOM edge of the screen, or the line nearest the TOP edge of the screen), holds the small yellow ball in one hand, throws it straight up into the air, and swings the racket ABOVE their head to hit the ball. The ball flies over the net (the dark band stretched across the middle of the court) to the other player. WHILE THE POINT IS HAPPENING, the yellow ball travels back and forth over the net:  the players swing and hit the ball again and again. Both players move quickly left and right and swing their arms. THE POINT ENDS the moment the ball stops going back over the net — the ball hits the dark net band in the middle and drops, OR the ball lands on the ground outside the painted white rectangle, OR  the ball bounces on the ground twice. AFTER A POINT ENDS, the players slow right down, walk around, pick balls up off the ground with their rackets, they sometimes go rest on the side and switch sides before getting back into position; this slow walking-around part is NOT a point, it is the empty gap between two points. Make one segment per point. Do not join two points into one segment and do not split one point into two. The slow walking-around gap, followed by a player throwing the ball up and hitting it above their head, is always the dividing line between one point and the next. A point usually lasts 2 to 20 seconds.",
    fields: [
      {
        name: "what_you_see",
        type: "string",
        description:
          "Fill this in FIRST, before the other fields, describing only THIS segment. In one or two plain sentences say: At the very start of the point, is the large near player at the bottom of the screen throwing the ball up and hitting it above his head, OR is he standing back and waiting to hit the ball after it comes over the net? What happens in the rally",
      },
      {
        name: "serving_player",
        type: "string",
        description:
          "Decide who STARTS this point by watching the NEAR player — the large player at the bottom of the screen, closest to the camera, who is easy to see clearly. CASE A: the NEAR (bottom) player stands ON or very near the nearest white line, bounces the small yellow ball, then throws the ball straight up into the air and hits it with the racket ABOVE his head — then serving_player = near_bottom. CASE B: the NEAR (bottom) player does NOT throw a ball up; instead he stands a step or two further back — lower down, closer to the bottom edge of the screen and closer to the camera than the serving spot — holds his racket low or ready in front of his body, waits and watches toward the far end, then swings only AFTER the ball has come over the net — this means the far player started the point, so serving_player = far_top. The far player is only a small dark figure near the top-middle of the court and is hard to see, so do NOT try to watch him directly; judge from what the near player is doing. HELPFUL BACKGROUND FOR CLOSE CALLS ONLY: the same player serves for a run of consecutive points — at least 4 in a row, usually about 6 to 10 — before the other player takes over the serving for the next run. Use this only when the near player's action is unclear: if this side has served only a few points in a row so far, the same server almost certainly continues; if this side has already served many points in a row (around 8 or more), it becomes more and more likely the serve has passed to the other side. This is a tie-breaker only — whenever you can actually see whether the near player is serving or waiting to return, TRUST WHAT YOU SEE over this background. near_bottom = the large player at the bottom of the screen. far_top = the small player near the top-middle of the court. cannot_tell = the near player is out of frame or you genuinely cannot decide." +
          nearHint +
          farHint +
          notes,
        enum: ["near_bottom", "far_top", "cannot_tell"],
      },
    ],
  };
}

/** Assemble the full create-task body for a rally analysis of `videoUrl`. */
export function buildRallyRequest(videoUrl: string, context?: RallyContext): CreateAnalysisTaskBody {
  return {
    video: { type: "url", url: videoUrl },
    model_name: PRESET.model_name,
    analysis_mode: PRESET.analysis_mode,
    temperature: PRESET.temperature,
    max_tokens: PRESET.max_tokens,
    min_segment_duration: PRESET.min_segment_duration,
    max_segment_duration: PRESET.max_segment_duration,
    response_format: {
      type: "segment_definitions",
      segment_time_format: "seconds",
      segment_definitions: [rallyDefinition(context)],
    },
  };
}
