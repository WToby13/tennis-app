import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="landing">
      <div className="landing-nav">
        <span className="brand-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={34} height={34} />
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
        <p className="lead">
          Set your phone at the back of the court and let Ojo capture the whole match. Review every
          point in slow motion, then share the moments that mattered with the people you played.
        </p>
        <div className="cta-row">
          <Link href="/sign-up" className="btn">
            Create your account
          </Link>
          <Link href="/sign-in" className="btn secondary">
            Sign in
          </Link>
        </div>
      </section>

      <section className="features">
        <div className="feature">
          <h3>Capture the full match</h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            One tap records the whole session in landscape — up to a couple of hours, straight from
            your iPhone.
          </p>
        </div>
        <div className="feature">
          <h3>Review point by point</h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Scrub, step frame by frame and slow it right down to see exactly what happened on that
            passing shot.
          </p>
        </div>
        <div className="feature">
          <h3>Share what matters</h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Send a private link to a hitting partner. They can watch it or add it to their own
            library in a tap.
          </p>
        </div>
      </section>
    </div>
  );
}
