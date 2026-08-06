import type { CreateAnalysisTaskBody, SegmentDefinition } from "./types";

/**
 * Admin-managed analysis config (finalized in docs/twelvelabs-tennis-handover.md).
 * Design principle: the model reports only what it can SEE about the NEAR player
 * per point; server / player identity / shot counts are reconstructed afterwards
 * from the fixed structure of a match (see lib/twelvelabs/smooth.ts).
 *
 * Field ORDER matters — `what_you_see` must stay first so the model observes
 * before committing to the enums (stops it emitting one constant template).
 */
export const RALLY_KIND = "rally";

/** Preset params — the finalized "Advanced settings". */
const PRESET = {
  model_name: "pegasus1.5",
  analysis_mode: "time_based_metadata",
  temperature: 0.2,
  max_tokens: 98304,
  min_segment_duration: 2,
  max_segment_duration: 30,
} as const;

/**
 * Optional per-match context for a future admin panel; appended to the prompt.
 * (The stronger fix for player-identity drift is attaching reference stills via
 * media_sources, per the handover — a later enhancement, not wired yet.)
 */
export interface RallyContext {
  notes?: string;
}

function rallyDefinition(context?: RallyContext): SegmentDefinition {
  const notes = context?.notes ? ` ${context.notes}` : "";
  return {
    id: RALLY_KIND,
    description:
      "Create one segment for each rally that is played. Here is exactly what a rally looks like in this video. A RALLY BEGINS when one player stands near the white line at the edge of their side (the line nearest the BOTTOM edge of the screen, or the line nearest the TOP edge of the screen), holds the small yellow ball in one hand, throws it straight up into the air, and hits it hard with the racket while the racket is ABOVE their head. The ball flies over the net (the dark band stretched across the middle of the court) to the other player who then hits it back. WHILE THE POINT IS HAPPENING, the yellow ball travels back and forth over the net: the players swing and hit the ball with rackets again and again. Both players jump and move quickly left and right and swing their arms. THE POINT ENDS the moment the ball stops going back over the net — the ball hits the dark net band in the middle OR the ball lands on the ground outside the painted white rectangle. AFTER A POINT ENDS, the players slow down, walk around, pick balls up off the ground with their rackets, they sometimes go rest on the side or switch sides before getting back into position; this slow walking-around part is NOT a point, it is the empty gap between two points. A long gap between the points usually means a switch in player serving. Make one segment per point. Do not join two points into one segment and do not split one point into two. The slow walking-around gap, followed by a player throwing the ball up and hitting it above their head, is always the dividing line between one point and the next. A point usually lasts 2 to 20 seconds." +
      notes,
    fields: [
      {
        name: "what_you_see",
        type: "string",
        description:
          "START FRESH HERE EVERY TIME, describing only THIS point in one or two plain sentences. Say only the things that can CHANGE from point to point: (a) at the very start, is the large near player at the bottom of the screen throwing the ball up and hitting it above his head, OR is he standing lower down waiting and only swinging after the ball has come over the net; and (b) roughly how many seconds the point lasts and how many times the ball crosses the net. Do NOT describe clothing here. Do not reuse the previous point's wording.",
      },
      {
        name: "near_player_role",
        type: "string",
        description:
          "What the large near player at the bottom of the screen is doing at the START of this point. serving = he stands on the white line, bounces the ball, throws it up and hits it above his head. receiving = he stands lower down, waits, and only swings after the ball has come over the net to him. (Expected to stay the same for several points in a row, then flip.)",
        enum: ["serving", "receiving", "unclear"],
      },
      {
        name: "near_player_identity",
        type: "string",
        description:
          "Which of the two players is the one nearest the camera at the bottom of the screen during THIS point. There are only two players in the whole match. Define them ONCE from stable features that do not change during the match (such as shirt colour, shirt number, cap colour, shorts, shoes, or hair): player_1 = the player who is nearest the camera at the very START of the video; player_2 = the other player. For every point, look at the near (bottom) player's stable features and output whichever player they match — keeping the SAME features tied to the SAME label for the entire video. (Expected to stay the same for several points in a row, then flip, because the near player changes only when the two players switch ends of the court.) unclear = you cannot make out the near player's features.",
        enum: ["player_1", "player_2", "unclear"],
      },
      {
        name: "times_ball_was_hit",
        type: "integer",
        description:
          "Your best WHOLE-NUMBER estimate of how many times a racket hits the ball this point: the first overhead hit, plus every later time the ball crosses back over the net. If you cannot count exactly, ESTIMATE from length — players hit about once every 2 seconds, so hits are roughly the point's length in seconds divided by 2 (4s≈2, 8s≈4, 12s≈6, 20s≈10). A longer point MUST get a higher number. Do not answer 2 or 3 for a point clearly longer than 6 seconds. Minimum 1.",
      },
    ],
  };
}

/**
 * Assemble the full create-task body for a rally analysis of `videoUrl`.
 * `startTimeSec` skips warm-up at the start (analysis window begins there);
 * returned segment timestamps stay absolute to the original video.
 */
export function buildRallyRequest(
  videoUrl: string,
  opts?: { startTimeSec?: number; context?: RallyContext },
): CreateAnalysisTaskBody {
  const body: CreateAnalysisTaskBody = {
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
      segment_definitions: [rallyDefinition(opts?.context)],
    },
  };
  if (opts?.startTimeSec && opts.startTimeSec > 0) body.start_time = Math.floor(opts.startTimeSec);
  return body;
}
