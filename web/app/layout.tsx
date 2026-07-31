import type { Metadata } from "next";
import Link from "next/link";
import { AuthNav } from "./AuthNav";
import { config } from "@/lib/config";
import { getUser } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tennis Recorder & Review",
  description: "Record, upload and review your tennis matches.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = config.authEnabled ? await getUser() : null;

  return (
    <html lang="en">
      <body>
        <header className="site">
          <Link href="/" className="brand">
            <span className="dot" />
            Tennis Review
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
