import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { AuthNav } from "./AuthNav";
import { config } from "@/lib/config";
import { getUser } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tennis Reel",
  description: "Record, review and share your tennis matches.",
  applicationName: "Tennis Reel",
  openGraph: {
    title: "Tennis Reel",
    description: "Record, review and share your tennis matches.",
    siteName: "Tennis Reel",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#d9662c",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = config.authEnabled ? await getUser() : null;

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
        <header className="site">
          <Link href="/" className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="mark" src="/logo.svg" alt="" width={28} height={28} />
            Tennis Reel
          </Link>
          <nav>
            <Link href="/">Matches</Link>
            <Link href="/upload">Upload</Link>
            {config.authEnabled && <AuthNav email={user?.email ?? null} />}
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
