import { ImageResponse } from "next/og";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TAGLINE } from "@/lib/site";

export const alt = `${SITE_NAME} — ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The card iMessage, WhatsApp and Slack unfurl when someone pastes an Ojo link.
 * Since the product spreads by one player sending another a match, this image is
 * the first impression far more often than the landing page is.
 *
 * Lives at the app root so every route inherits it — including /watch/[id],
 * which is the link people actually share. That page is behind auth, so the
 * unfurl is all a recipient sees before signing in.
 *
 * Drawn with plain flexbox because Satori (what ImageResponse renders with)
 * supports a subset of CSS: every element with more than one child needs an
 * explicit `display: flex`, and there is no `gap` shorthand inheritance.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#14110d",
          padding: "72px 80px",
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 84,
              height: 84,
              borderRadius: 22,
              background: "#d9662c",
              color: "#14110d",
              fontSize: 54,
              fontWeight: 700,
            }}
          >
            O
          </div>
          <div
            style={{
              marginLeft: 24,
              color: "#f4eee4",
              fontSize: 44,
              fontWeight: 600,
              letterSpacing: "-0.02em",
            }}
          >
            {SITE_NAME}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              color: "#d9662c",
              fontSize: 22,
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
            }}
          >
            {SITE_TAGLINE}
          </div>
          <div
            style={{
              marginTop: 20,
              color: "#f4eee4",
              fontSize: 68,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
            }}
          >
            Your matches, worth watching back.
          </div>
          <div
            style={{
              marginTop: 24,
              color: "#a89c8a",
              fontSize: 27,
              lineHeight: 1.4,
              maxWidth: 900,
            }}
          >
            {SITE_DESCRIPTION}
          </div>
        </div>

        {/* Clay baseline, echoing the court */}
        <div style={{ display: "flex", height: 8, background: "#d9662c", borderRadius: 4 }} />
      </div>
    ),
    size,
  );
}
