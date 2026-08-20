import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Everything behind auth is disallowed. Crawlers get redirected to /sign-in
 * there anyway, but saying so explicitly keeps signed-in URLs (and the share
 * tokens hanging off /watch links) out of crawl logs and index reports.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/auth/", "/watch/", "/matches", "/profile", "/upload", "/u/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
