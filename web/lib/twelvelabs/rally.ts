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

/**
 * The `near_player_identity` vocabulary.
 *
 * Deliberately NOT `player_1` / `player_2`. Those read as match-global labels,
 * and a windowed run cannot produce one: every window is its own task, so a
 * window starting at 15:00 has never seen the start of the match and anchors
 * "player 1" to whoever happened to be near at 15:00. Six windows minted six
 * unrelated labellings that all looked alike downstream.
 *
 * These values are honest about their scope — they are relative to the first
 * point of THIS clip, and nothing else. Stitching them into a match-wide
 * identity is ../twelvelabs/windows.ts's job (link the windows through their
 * overlap) and smooth.ts's (fit the changeover pattern over what's left).
 */
export const NEAR_SAME = "same_as_first";
export const NEAR_OTHER = "other_player";
export const NEAR_UNCLEAR = "unclear";

/**
 * The `serve_came_from` vocabulary — which END the point's first shot came from.
 *
 * This replaced a `near_player_role` field asking whether the near player was
 * "serving" or "receiving", which came back 95/13 on a real 57-minute match
 * where the true split is close to even. Asking the model to classify a POSTURE
 * — crouched, leaning, racket held out, no spare balls nearby — turned out to be
 * a question it answers by defaulting, and the answer feeds the server fit, so
 * a lopsided one costs accuracy directly.
 *
 * Every point opens with one unmistakable event: a player throws the ball up and
 * hits it above their head. Which end that happened at is the same information,
 * observed in one moment rather than inferred from stance.
 */
export const SERVE_BOTTOM = "bottom";
export const SERVE_TOP = "top";

/** Preset params — the finalized "Advanced settings". */
const PRESET = {
  model_name: "pegasus1.5",
  analysis_mode: "time_based_metadata",
  // Back where it started, after a spell at 0.5.
  //
  // It was raised because a 32-minute match came back templated — one identity,
  // one role and four distinct `what_you_see` strings across all 96 points — on
  // the theory that at a low temperature the model's cheapest continuation is to
  // repeat the previous point's answer. Windowing (./windows.ts) then addressed
  // that same failure at its source: the templating was a function of how deep
  // into a long call the model was, and a 5-minute window came back with
  // irregular, realistic timings regardless. With the driver gone, the extra
  // sampling noise buys nothing and costs stability on four heavily-constrained
  // enums, which the smoother then has to vote back out.
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
      "Create one segment for each rally that is played. Here is exactly what a rally looks like in this video. A RALLY BEGINS when one player stands near the white line at the edge of their side (the line nearest the BOTTOM edge of the screen, or the line nearest the TOP edge of the screen), holds the small yellow ball in one hand, throws it straight up into the air, and hits it hard with the racket while the racket is ABOVE their head. The ball flies over the net (the dark band stretched across the middle of the court) to the other player who then hits it back. WHILE THE POINT IS HAPPENING, the yellow ball travels back and forth over the net: the players swing and hit the ball with rackets again and again. Both players jump and move quickly left and right and swing their arms. THE POINT ENDS the moment the ball stops going back over the net — the ball hits the dark net band in the middle OR the ball lands on the ground outside the painted white rectangle. AFTER A POINT ENDS, the players slow down, walk around, pick balls up off the ground with their rackets, they sometimes go rest on the side or switch sides before getting back into position; this slow walking-around part is NOT a point, it is the empty gap between two points. A long gap between the points usually means a switch in player serving. Make one segment per point. Do not join two points into one segment and do not split one point into two. The slow walking-around gap, followed by a player throwing the ball up and hitting it above their head, is always the dividing line between one point and the next. A point usually lasts 2 to 20 seconds. This video is a short clip cut from the middle of a longer match, so it may begin and end part-way through the play. No two points are alike: how long a point lasts, how many times the ball crosses the net and how it ends are different every time. Answer each segment from what is on screen during that segment. Never copy your answers from the previous segment." +
      notes,
    fields: [
      {
        name: "what_you_see",
        type: "string",
        description:
          "START FRESH HERE EVERY TIME, describing only THIS point in one or two plain sentences. Say only the things that can CHANGE from point to point: (a) at the very start, is the large near player at the bottom of the screen throwing the ball up and hitting it above his head, OR is he standing lower down waiting and only swinging after the ball has come over the net; and (b) roughly how many seconds the point lasts and how many times the ball crosses the net. Do NOT describe clothing here. Do not reuse the previous point's wording.",
      },
      {
        name: "serve_came_from",
        type: "string",
        description:
          `Every point begins with one player throwing the ball straight up into the air and hitting it hard with the racket while the racket is ABOVE their head. Find that FIRST hit of THIS point and say which end of the court it came from. ${SERVE_BOTTOM} = the big player nearest the camera, at the BOTTOM of the screen, threw the ball up and hit it; the ball starts near the bottom edge and travels away from the camera. ${SERVE_TOP} = the small player at the far end, at the TOP of the screen, threw the ball up and hit it; the ball starts near the top edge and travels toward the camera. Judge it from the first two seconds of THIS point and from that one shot alone — watch which player's racket goes above their head and which direction the ball first travels. Do not work it out from who served the point before. ${NEAR_UNCLEAR} = the start of the point is off screen, or you cannot see which player hit the ball first.`,
        enum: [SERVE_BOTTOM, SERVE_TOP, NEAR_UNCLEAR],
      },
      {
        name: "near_player_identity",
        type: "string",
        description:
          `Which of the two players is nearest the camera at the bottom of the screen during THIS point, compared with the FIRST point of this clip. There are only two players. Look at the near player in the first point of the clip and fix their stable features in mind — the things that cannot change while they play, such as shirt colour, shirt number, cap colour, shorts, shoes or hair. ${NEAR_SAME} = the near player in THIS point has those same features. ${NEAR_OTHER} = the near player in THIS point is the other of the two players. Read the features off THIS point rather than carrying the answer over from the previous point. The near player swaps only when the two players change ends and walk past each other; in a clip this short that may happen once, or not at all, so do not force both answers to appear. ${NEAR_UNCLEAR} = you cannot make out the near player's features.`,
        enum: [NEAR_SAME, NEAR_OTHER, NEAR_UNCLEAR],
      },
      {
        name: "times_ball_was_hit",
        type: "integer",
        description:
          "COUNT how many times a racket hits the ball this point: the first overhead hit, plus every later time the ball crosses back over the net. Count the actual swings you can see in THIS point rather than working it out from a formula. Only if the ball is genuinely too hard to follow, fall back on roughly one hit per two seconds of play. A longer point MUST get a higher number than a shorter one, and real points vary a lot, so the same number repeated for point after point is wrong. Minimum 1.",
      },
    ],
  };
}

/**
 * Assemble the full create-task body for a rally analysis of `videoUrl`.
 *
 * `startTimeSec` / `endTimeSec` bound the analysis window — used both to skip
 * warm-up at the start and to split a long match into short windows (see
 * ./windows.ts, which also handles putting the returned timestamps back on the
 * match's clock).
 */
export function buildRallyRequest(
  videoUrl: string,
  opts?: { startTimeSec?: number; endTimeSec?: number; context?: RallyContext },
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
  if (opts?.endTimeSec && opts.endTimeSec > (opts.startTimeSec ?? 0)) {
    body.end_time = Math.ceil(opts.endTimeSec);
  }
  return body;
}
