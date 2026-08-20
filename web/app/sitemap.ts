import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Only the pages a signed-out visitor can actually reach. `/` is deliberately
 * absent: for anyone not signed in it 307s to /landing, and listing a
 * redirecting URL just earns a "Page with redirect" warning in Search Console.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: `${SITE_URL}/landing`, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/sign-up`, lastModified, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/sign-in`, lastModified, changeFrequency: "monthly", priority: 0.3 },
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
