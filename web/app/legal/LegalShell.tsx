import Link from "next/link";

/**
 * Chrome shared by /privacy and /terms — the landing page's header and footer
 * around a single readable column.
 *
 * These two pages have to be reachable with no session (App Store review opens
 * the privacy policy URL before it ever signs in, and so does anyone deciding
 * whether to sign up), so they render standalone rather than inside the app
 * shell. See `PUBLIC_PREFIXES` in Shell.tsx and `publicPrefixes` in middleware.
 */
export function LegalShell({
  title,
  updated,
  children,
}: {
  title: string;
  /** ISO date the document last changed — shown, and the thing users check. */
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="landing">
      <div className="landing-nav">
        <Link href="/landing" className="brand-lg">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="Ojo Tennis logo" width={34} height={34} />
          Ojo Tennis
        </Link>
        <Link href="/sign-in" className="btn secondary">
          Sign in
        </Link>
      </div>

      <article className="legal">
        <h1>{title}</h1>
        <p className="muted legal-updated">
          Last updated{" "}
          {new Date(updated).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </p>
        {children}
      </article>

      <footer className="landing-footer">
        <span className="muted">© {new Date().getFullYear()} Ojo Tennis</span>
        <span className="landing-footer-links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/landing">Home</Link>
        </span>
      </footer>
    </div>
  );
}
