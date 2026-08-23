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
export const ROLE_RECEIVING = "receiving";
export const ROLE_SERVING = "serving";

/**
 * The previous vocabulary for the same question, asked the other way round:
 * which END the serve came from. Kept so rows analysed under it still smooth.
 *
 * It was replaced because it needed the far player to be legible, and he is not.
 * Measured one-sidedness across five runs: 80%, 83%, 88%, 95% and finally 100%,
 * where a true split is near 50% — the last of those failed a match outright on
 * the constant-role guard. The posture question it replaced, which only ever
 * looks at the near player, ran 79%, 82% and 83% across three matches: less
 * biased, and far steadier, because it never depends on whether the small figure
 * at the top of the screen happened to be readable that day.
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
      "Create one segment for each rally that is played. Here is exactly what a rally looks like in this video. Two players stand at opposite ends of a painted court with a net — the dark band stretched across the middle — between them: one near the BOTTOM of the screen who looks large, and one near the TOP of the screen who looks small. They hit a small yellow ball to each other over the net with rackets. " +
      "A RALLY STARTS on the first hit of the point. A player stands near the white line at the edge of their side, holds the yellow ball in one hand, throws it straight up into the air and hits it hard with the racket while the racket is ABOVE their head. You will see this either as the near player at the bottom of the screen making that overhead hit himself, or, when the ball is served from the top end instead, as the near player swinging to hit the ball back a moment later. Begin the segment on that first hit — never while a player is still bouncing the ball, still walking to the line, or still standing waiting. " +
      "WHILE THE RALLY IS HAPPENING the yellow ball travels back and forth over the net, the players swing at it and hit it again and again, and both of them move quickly left and right. " +
      "A RALLY ENDS when the ball stops going back over the net — it drops into the dark net band, or it lands on the ground outside the painted white lines — and the players stop hitting, stop moving quickly, and begin to walk. End the segment on that last hit, NOT after the walking has started. " +
      "THE TIME BETWEEN TWO RALLIES IS NOT PART OF EITHER OF THEM. In between, the players walk around, pick balls up off the ground with their rackets, bounce a ball before serving, take a drink, and sometimes go out of the picture altogether. That time is ALWAYS somewhere between 5 and 60 seconds long, and none of it belongs inside a segment. The longer gaps, 30 seconds and more, usually mean the serve has changed to the other player or the two of them have swapped ends of the court; that is completely normal and does NOT mean a rally has been missed. " +
      "Make one segment per rally. Do not join two rallies into one segment and do not split one rally into two. Most rallies are SHORT: about 3 to 10 seconds of hitting, and only a long exchange reaches 20. This video is a short clip cut from the middle of a longer match, so it may begin and end part-way through the play. No two rallies are alike: how long one lasts, how many times the ball crosses the net and how it ends are different every time. Answer each segment from what is on screen during that segment. Never copy your answers from the previous segment." +
      notes,
    fields: [
      {
        name: "what_you_see",
        type: "string",
        description:
          "In one plain sentence, IN YOUR OWN WORDS, say how THIS point ENDED — the very last thing that happens to the ball before the two players stop running. Watch the final shot and write down what you actually saw: which of the two players played it, what the shot looked like, and where the ball finished up. Write it fresh from the picture rather than choosing from a set of phrases. No two points end quite the same way, so no two of these sentences should read the same — if you are about to write the sentence you wrote for the last point, look at the screen again and say what is different about this one. Do NOT say who served, do NOT say how long the point lasted, and do NOT describe anyone's clothing.",
      },
      {
        name: "near_player_role",
        type: "string",
        description:
          `Look ONLY at the big player nearest the camera, at the BOTTOM of the screen, during the first two seconds of THIS point, and say which of these two things he is doing. Ignore the far player completely — you do not need to see him at all to answer this. ${ROLE_RECEIVING} = he is NOT holding a ball. There is no yellow ball in his hand, and none on the ground by his feet either; the balls are all away at the far end. He stands still, a little way inside the court, knees bent and leaning forward, holding the racket out in front of him with both hands, sometimes bouncing gently on his toes. He does nothing at all until the ball comes over the net towards him, and only then does he move and swing. ${ROLE_SERVING} = he IS holding a ball. There is a yellow ball in one hand, and usually a spare one in his pocket or lying on the ground beside him. He stands right back at the white line along the very bottom edge of his side, often bounces the ball a few times first, then throws it straight up into the air and hits it with the racket ABOVE his head. The ball in his hand is the surest sign of the two: a player about to serve is always holding one, and a player waiting to receive never is — so look at his hands first. Read it off THIS point and never carry the answer over from the previous one. ${NEAR_UNCLEAR} = the near player is out of the picture, or you cannot see him at the moment the point starts.`,
        enum: [ROLE_RECEIVING, ROLE_SERVING, NEAR_UNCLEAR],
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
