import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import { Shell } from "./Shell";
import { WebAnalytics } from "./WebAnalytics";
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

// Self-hosted at build time by next/font: no render-blocking request to
// fonts.googleapis.com, no extra DNS+TLS handshake, and no layout shift when the
// webfont lands — which is most of the landing page's LCP.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} — record, review and share your tennis matches`,
    // Inner pages set a bare title and get the brand appended.
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "tennis video app",
    "record tennis match",
    "tennis match review",
    "tennis video analysis",
    "film your tennis match",
    "tennis slow motion review",
    "share tennis highlights",
    "iPhone tennis camera",
  ],
  category: "sports",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${SITE_NAME} — record, review and share your tennis matches`,
    description: SITE_DESCRIPTION,
    siteName: SITE_NAME,
    url: SITE_URL,
    locale: "en_GB",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — record, review and share your tennis matches`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      // Lets Google show the OG card and a full-length snippet in results,
      // which is what AI Overviews and answer engines quote from.
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  appleWebApp: { capable: true, title: SITE_NAME, statusBarStyle: "black-translucent" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#14110d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
      <body>
        <Shell>{children}</Shell>
        <WebAnalytics />
      </body>
    </html>
  );
}
