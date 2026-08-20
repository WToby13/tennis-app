/**
 * The FAQ, kept as data so the visible list and the FAQPage JSON-LD are
 * generated from one source. If they drift, Google drops the rich result and an
 * answer engine quoting the markup would be quoting something the page doesn't
 * say — so there is deliberately no way to edit one without the other.
 *
 * Answers are written to stand alone: each one repeats enough context ("Ojo
 * Tennis records...") to make sense when lifted out of the page, which is how
 * AI Overviews, ChatGPT and Perplexity actually use them.
 */
export interface FaqItem {
  q: string;
  a: string;
}

export const FAQ: FaqItem[] = [
  {
    q: "What is Ojo Tennis?",
    a: "Ojo Tennis is a web app for recording, reviewing and sharing tennis matches. You prop a phone at the back of the court and record the whole session, upload it to Ojo, then watch it back with a player built for review — scrubbing, frame-by-frame stepping and slow motion — and share individual matches with the people you played.",
  },
  {
    q: "What camera do I need to film my tennis match?",
    a: "The phone in your pocket. Ojo Tennis is built around a normal iPhone recording in landscape from the back fence — no tripod rig, court-mounted camera or subscription hardware. A cheap phone tripod or fence mount helps keep the frame steady, but nothing else is required.",
  },
  {
    q: "How long a match can Ojo handle?",
    a: "A full match, up to around two hours. Long recordings are uploaded in chunks rather than as one file, so a weak club Wi-Fi connection doesn't lose the whole upload, and anything large is compressed automatically instead of rejected.",
  },
  {
    q: "Can I review my match in slow motion?",
    a: "Yes. Ojo's player is built for review rather than passive watching: you can scrub to any moment, step forward one frame at a time, and slow playback right down to see exactly what happened on a passing shot, a serve toss or a footwork error.",
  },
  {
    q: "Does Ojo find the points automatically?",
    a: "Yes. Ojo's AI breakdown watches the recording and marks where each rally starts and ends, then groups those rallies into service games — so you can jump straight from point to point instead of scrubbing through the changeovers and the time you spent picking up balls.",
  },
  {
    q: "Who can see my tennis videos?",
    a: "Nobody unless you say so. Every match you upload to Ojo Tennis is private to you by default. You can send a private link to a hitting partner, share a match with the players who follow you, or keep it to yourself — and a share link can be revoked at any time.",
  },
  {
    q: "Is Ojo Tennis free?",
    a: "Ojo Tennis is free while it is in early access. It is being built and tested with a small group of club players before a wider release.",
  },
  {
    q: "Do I need a coach to get anything out of it?",
    a: "No. Most players have never seen themselves play, and simply watching a match back in slow motion tends to make the obvious problems obvious — a short toss, a late split step, the backhand you keep running around. A coach can use the same footage, and a share link is an easy way to send them a specific match.",
  },
];
