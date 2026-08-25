"use client";

import { Analytics } from "@vercel/analytics/react";
import { hasOptedOut } from "@/lib/analytics/client";

/**
 * Vercel Web Analytics — anonymous pageviews and referrers.
 *
 * This is the half of measurement Supabase can't do: where signed-out traffic
 * comes from, and whether the SEO/GEO work in docs/GTM.md §5 actually lands.
 * It sets no cookie and stores no identifier that survives the day, which is why
 * it can run without a consent banner.
 *
 * A client component only so `beforeSend` can be a function: it makes the
 * Settings opt-out cover pageviews too, rather than leaving someone who asked
 * not to be measured still being counted here.
 */
export function WebAnalytics() {
  return <Analytics beforeSend={(event) => (hasOptedOut() ? null : event)} />;
}
