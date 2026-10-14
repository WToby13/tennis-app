/**
 * Canonical identity of the site, in one place: metadata, robots, sitemap,
 * JSON-LD and the OG card all read from here so they can't drift apart.
 */
export const SITE_URL = "https://ojotennis.com";

export const SITE_NAME = "Ojo Tennis";

/**
 * The one-line answer to "what is this?". Used as the meta description, the OG
 * description and the JSON-LD description. Written to be quotable on its own —
 * an answer engine that lifts this single sentence should still convey what the
 * product is, who it's for and what it runs on.
 */
export const SITE_DESCRIPTION =
  "Ojo Tennis records your whole match from an iPhone at the back of the court, then lets you review every point in slow motion and share the ones that mattered.";

/** Shown under the wordmark on the social card. */
export const SITE_TAGLINE = "Record · Review · Share";

/** The iPhone app on the App Store (Ojo Tennis, com.ojotennis.app). */
export const APP_STORE_ID = "6805535843";
export const APP_STORE_URL = `https://apps.apple.com/app/id${APP_STORE_ID}`;

/**
 * A link that opens the iPhone app at the same place: `ojo://watch/<id>` for a
 * match (with its share token, so a shared private match opens too), else the
 * app's home. The app reads these in ios/Ojo/Ojo/DeepLinks.swift.
 */
export function appLink(pathname: string, shareToken?: string | null): string {
  const match = pathname.match(/^\/watch\/([0-9a-f-]{36})/i);
  if (!match) return "ojo://open";
  return `ojo://watch/${match[1]}${shareToken ? `?s=${encodeURIComponent(shareToken)}` : ""}`;
}
