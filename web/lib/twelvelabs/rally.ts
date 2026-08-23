import type { CreateAnalysisTaskBody, SegmentDefinition } from "./types";

/**
 * Admin-managed analysis config (finalized in docs/twelvelabs-tennis-handover.md).
 * Design principle: the model reports only what it can SEE about the NEAR player
 * per point; server / player identity / shot counts are reconstructed afterwards
 * from the fixed structure of a match (see lib/twelvelabs/smooth.ts).
 *
 * Field ORDER matters — `what_you_see` stays first so the model looks at the
 * video before committing to the enums.
 *
 * What it is asked to look at changed, though. It used to ask for the start of
 * the point and its length, which was a mistake twice over: both were already
 * covered by other fields, so the sentence became a recitation of them ("The
 * near player serves from the bottom. The rally lasts about 3 seconds…" came
 * back 13 times in one match, and distinct wording fell run on run, 63% to 50%
 * to 40%). Worse, it made the model commit to a server in prose BEFORE the
 * serve field was answered, which is a plausible reason that field kept sliding
 * further toward "the near player did it".
 *
 * It now asks how the point ENDED, which no other field asks about, genuinely
 * differs point to point, and cannot be recited from an enum.
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

/**
 * The `players_swapped_ends_before` vocabulary.
 *
 * A field rather than a second segment definition, which is the same question
 * asked the cheap way: TwelveLabs bills per segment definition, so a separate
 * `game` definition would roughly double the bill, while another field on the
 * one we already send costs a few output tokens.
 *
 * It exists because the gap signal turned out not to be there. ./smooth.ts finds
 * game boundaries by looking for a long pause, but on a real 49-minute match
 * only FOUR gaps exceeded 30s where about twenty games' worth were needed — the
 * model's segments swallow the pauses, so the boundaries it should be inferring
 * are simply not visible in the timings. A changeover, though, is a slow and
 * unmistakable thing to look at: two people walking the length of the court and
 * crossing at the net. Describing that is what this model is good at.
 */
export const SWAP_YES = "yes";
export const SWAP_NO = "no";

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
  // 30 let too much in. Measured on a real 49-minute match, 62% of the running
  // time came back inside a "rally" segment, against 20-30% for actual tennis —
  // the model was swallowing the walk-back and the setup either side of the
  // point. That matters more than it sounds: everything downstream (games,
  // changeovers, servers) is inferred from the GAPS between rallies, and at 62%
  // coverage the median gap was 6 seconds, so there was almost no gap signal
  // left to read. Real points at this level are 3-10s and rarely past 20.
  //
  // Advisory in practice — that same run returned four segments longer than the
  // 30 it was given, up to 58s — so this leans on the prompt to do the real
  // work, and is set to match what the prompt now asks for.
  max_segment_duration: 20,
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
      "Create one segment for each rally that is played. Here is exactly what a rally looks like in this video. A RALLY BEGINS when one player stands near the white line at the edge of their side (the line nearest the BOTTOM edge of the screen, or the line nearest the TOP edge of the screen), holds the small yellow ball in one hand, throws it straight up into the air, and hits it hard with the racket while the racket is ABOVE their head. The ball flies over the net (the dark band stretched across the middle of the court) to the other player who then hits it back. WHILE THE POINT IS HAPPENING, the yellow ball travels back and forth over the net: the players swing and hit the ball with rackets again and again. Both players jump and move quickly left and right and swing their arms. THE POINT ENDS the moment the ball stops going back over the net — the ball hits the dark net band in the middle OR the ball lands on the ground outside the painted white rectangle. The segment you make must cover ONLY the time the ball is actually flying between the two players. It must START on the hit above the head, not while the player is still bouncing the ball or walking to the line, and it must STOP on the very frame the ball stops crossing, not when the players have finished walking about afterwards. The empty gap between two points must never be inside a segment. AFTER A POINT ENDS, the players slow down, walk around, pick balls up off the ground with their rackets, they sometimes go rest on the side or switch sides before getting back into position; this slow walking-around part is NOT a point, it is the empty gap between two points. A long gap between the points usually means a switch in player serving. Make one segment per point. Do not join two points into one segment and do not split one point into two. The slow walking-around gap, followed by a player throwing the ball up and hitting it above their head, is always the dividing line between one point and the next. Most points are SHORT: about 3 to 10 seconds from the overhead hit to the ball stopping, and only a long exchange reaches 20. This video is a short clip cut from the middle of a longer match, so it may begin and end part-way through the play. No two points are alike: how long a point lasts, how many times the ball crosses the net and how it ends are different every time. Answer each segment from what is on screen during that segment. Never copy your answers from the previous segment." +
      notes,
    fields: [
      {
        name: "what_you_see",
        type: "string",
        description:
          "In one plain sentence, say how THIS point ENDED — the very last thing that happens to the ball before the two players stop running and start walking. Name which player hit that final shot (the big one at the bottom of the screen, or the small one at the top), and then what the ball did: dropped into the dark net band across the middle; sailed over the far white line and bounced on the ground beyond it; bounced outside one of the white lines at the side; or flew past the other player, who reached for it and missed. Every point ends in its own way, so this sentence should come out different every time — if you are about to write the sentence you wrote for the last point, look at the screen again. Do NOT say who served, do NOT say how long the point lasted, and do NOT describe anyone's clothing.",
      },
      {
        name: "serve_came_from",
        type: "string",
        description:
          `Every point begins with one player throwing the ball straight up and hitting it while the racket is ABOVE their head. Answer this by watching WHICH WAY THE BALL TRAVELS in the first second or two of THIS point, before it has crossed the net even once. ${SERVE_TOP} = the ball sets off TOWARDS the camera. It starts high up in the picture, near the small player at the top, and moves DOWN the screen towards you, getting bigger as it comes; the small far player is the one whose racket went above their head. ${SERVE_BOTTOM} = the ball sets off AWAY from the camera. It starts low down in the picture, near the big player at the bottom, and moves UP the screen and away, getting smaller as it goes; that big near player is the one whose racket went above their head. Check the far end FIRST: the far player is small and their swing is easy to miss, so look at the top of the picture and rule that out before you settle on the near player. Over a match the two ends serve about equally often, so if you find yourself giving the same answer point after point, look again. Do not work it out from who served the point before. ${NEAR_UNCLEAR} = the start of the point is off screen, or you cannot follow which way the ball first went.`,
        enum: [SERVE_TOP, SERVE_BOTTOM, NEAR_UNCLEAR],
      },
      {
        name: "players_swapped_ends_before",
        type: "string",
        description:
          `Look at the gap BEFORE this point starts, and say whether the two players changed ends of the court in it. When they change ends they both stop playing, walk the whole length of the court and PAST EACH OTHER near the middle net, and each one carries on to the end the other one has just left; they usually stop by the side of the court first for a drink or a towel, and the whole thing takes far longer than an ordinary gap between two points. ${SWAP_YES} = that full swap happened in the gap immediately before THIS point, so the big near player at the bottom of the screen is now a DIFFERENT person from the one who was standing there earlier. ${SWAP_NO} = the gap before this point was an ordinary short one and both players stayed at their own ends. This is uncommon — in a few minutes of play it happens once, or not at all — so ${SWAP_NO} is the right answer for most points, and ${SWAP_YES} only when you actually watch the two of them cross. ${NEAR_UNCLEAR} = the gap before this point is not on screen.`,
        enum: [SWAP_YES, SWAP_NO, NEAR_UNCLEAR],
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
