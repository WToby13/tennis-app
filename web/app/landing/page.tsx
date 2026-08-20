import type { Metadata } from "next";
import Link from "next/link";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";
import { FAQ } from "./faq";
import { LandingJsonLd } from "./jsonld";

export const metadata: Metadata = {
  // `absolute` so the root layout's "· Ojo Tennis" suffix isn't appended to a
  // title that already carries the brand.
  title: { absolute: `${SITE_NAME} — record, review and share your tennis matches` },
  description: SITE_DESCRIPTION,
  // Self-canonical. `/` 307s here for anyone signed out, and pointing the
  // canonical back at a redirecting URL just makes both ends ambiguous.
  alternates: { canonical: "/landing" },
  // No `openGraph` override here on purpose: a page-level openGraph object
  // replaces the layout's wholesale, which drops og:site_name, og:locale and —
  // worst of all — the auto-injected og:image from app/opengraph-image.tsx.
};

const STEPS = [
  {
    n: "01",
    h: "Prop your phone at the back of the court",
    p: "Landscape, behind the baseline, roughly at fence height. One tap records the whole session — both players, every point, up to a couple of hours.",
  },
  {
    n: "02",
    h: "Upload it when you're done",
    p: "The match uploads in chunks, so patchy club Wi-Fi doesn't cost you the whole file. Big matches are compressed automatically rather than refused.",
  },
  {
    n: "03",
    h: "Watch it back properly",
    p: "Scrub to any moment, step frame by frame, slow it right down. Then send the match to the person you played, or keep it to yourself.",
  },
];

const FEATURES = [
  {
    h: "Built for review, not watching",
    p: "Frame-step, variable speed and a scrubber that actually lands where you drop it. The difference between “I lost that point” and seeing your toss drift behind your head.",
  },
  {
    h: "The points, found for you",
    p: "Ojo's AI breakdown marks where each rally starts and ends and groups them into service games, so you can jump point to point instead of scrubbing past the ball-collecting.",
  },
  {
    h: "Private until you decide",
    p: "Every match is yours alone by default. Send a private link to a hitting partner, post it to the players who follow you, or share nothing at all. Links can be revoked.",
  },
  {
    h: "Both players get the footage",
    p: "The person on the other side of the net can open your link and add the match to their own library in a tap — no re-upload, no second copy, no account admin.",
  },
  {
    h: "Your matches in one library",
    p: "Every session you've recorded, with the score, the opponent and the date, instead of eleven untitled 4 GB files buried in your camera roll.",
  },
  {
    h: "No hardware to buy",
    p: "No court-mounted camera, no tripod rig, no subscription to a box on a pole. The phone already in your bag is the whole setup.",
  },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <LandingJsonLd />

      <div className="landing-nav">
        <span className="brand-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Ojo Tennis logo" width={34} height={34} />
          Ojo Tennis
        </span>
        <Link href="/sign-in" className="btn secondary">
          Sign in
        </Link>
      </div>

      <section className="landing-hero">
        <div className="eyebrow">Record · Review · Share</div>
        <h1 style={{ marginTop: 14 }}>
          Your matches,
          <br />
          worth watching back.
        </h1>
        {/* The definitional sentence. First thing a crawler or an answer engine
            reads after the H1, and the one most likely to be quoted whole. */}
        <p className="lead">
          <strong>Ojo Tennis</strong> is a tennis video app that records your whole match from a
          phone at the back of the court, finds every point automatically, and lets you review them
          in slow motion — then share the ones that mattered with the people you played.
        </p>
        <div className="cta-row">
          <Link href="/sign-up" className="btn">
            Create your account
          </Link>
          <Link href="/sign-in" className="btn secondary">
            Sign in
          </Link>
        </div>
        <p className="landing-note">Free while we're in early access.</p>
      </section>

      <section className="landing-section" aria-labelledby="how">
        <h2 id="how" className="section-title">
          How it works
        </h2>
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.n} className="step">
              <span className="step-n">{s.n}</span>
              <h3>{s.h}</h3>
              <p className="muted">{s.p}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section" aria-labelledby="what">
        <h2 id="what" className="section-title">
          What you get
        </h2>
        <div className="features">
          {FEATURES.map((f) => (
            <div key={f.h} className="feature">
              <h3>{f.h}</h3>
              <p className="muted">{f.p}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section" aria-labelledby="faq">
        <h2 id="faq" className="section-title">
          Questions
        </h2>
        <div className="faq">
          {FAQ.map(({ q, a }) => (
            <details key={q} className="faq-item">
              <summary>
                <h3>{q}</h3>
              </summary>
              <p className="muted">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="landing-cta">
        <h2>Play today, watch it tonight.</h2>
        <p className="muted">
          Most players have never seen themselves play. It's usually a surprise.
        </p>
        <div className="cta-row">
          <Link href="/sign-up" className="btn">
            Create your account
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <span className="muted">© {new Date().getFullYear()} Ojo Tennis</span>
        <span className="landing-footer-links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up">Create account</Link>
        </span>
      </footer>
    </div>
  );
}
