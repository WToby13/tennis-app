import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Shell } from "./Shell";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://ojotennis.com"),
  title: "Ojo Tennis",
  description: "Record, review and share your tennis matches.",
  applicationName: "Ojo Tennis",
  openGraph: {
    title: "Ojo Tennis",
    description: "Record, review and share your tennis matches.",
    siteName: "Ojo Tennis",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#14110d",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Shell>{children}</Shell>
        <Analytics />
      </body>
    </html>
  );
}
