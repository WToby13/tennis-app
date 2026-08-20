import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import { FAQ } from "./faq";

/**
 * Structured data for the landing page.
 *
 * Two audiences, one payload. Google uses FAQPage for rich results and the
 * SoftwareApplication/Organization pair to resolve "Ojo Tennis" as an entity
 * rather than two ordinary words. Answer engines (AI Overviews, ChatGPT search,
 * Perplexity) lean on the same graph because it states plainly what the thing
 * is, what it runs on and what it costs — facts they otherwise have to infer
 * from marketing prose, usually wrongly.
 *
 * `@graph` with explicit `@id`s so the nodes reference each other instead of
 * being three unrelated blobs.
 */
export function LandingJsonLd() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: SITE_NAME,
        url: SITE_URL,
        logo: `${SITE_URL}/icon-512.png`,
        description: SITE_DESCRIPTION,
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        publisher: { "@id": `${SITE_URL}/#organization` },
        inLanguage: "en",
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${SITE_URL}/#app`,
        name: SITE_NAME,
        applicationCategory: "SportsApplication",
        applicationSubCategory: "Tennis video analysis",
        operatingSystem: "Web, iOS",
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        publisher: { "@id": `${SITE_URL}/#organization` },
        featureList: [
          "Record a full tennis match from a phone at the back of the court",
          "Frame-by-frame and slow-motion match review",
          "Automatic detection of rallies and service games",
          "Private-by-default matches with revocable share links",
          "Follow other players and see their matches in a feed",
        ],
        // Free in early access. Stated explicitly because "is it free?" is the
        // question answer engines get asked about every app, and an absent
        // offer gets guessed at.
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "GBP",
          availability: "https://schema.org/LimitedAvailability",
        },
      },
      {
        "@type": "FAQPage",
        "@id": `${SITE_URL}/#faq`,
        isPartOf: { "@id": `${SITE_URL}/#website` },
        mainEntity: FAQ.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };

  return (
    <script
      type="application/ld+json"
      // Server-rendered from our own constants — no user input reaches this.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}
