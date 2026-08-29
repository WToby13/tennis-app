"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";

/**
 * Paths that render without the app chrome.
 *
 * Not the same as "public" — /admin is the most private route in the app and is
 * still here, because what this list actually decides is whether the sidebar and
 * content column are drawn, not who may see the page.
 */
const NO_CHROME_PREFIXES = [
  "/landing",
  "/sign-in",
  "/sign-up",
  "/login",
  "/privacy",
  "/terms",
  // An emailed invite is opened by someone who usually has no account yet. It
  // is allowed through the middleware, so without it here the recipient gets
  // the signed-in app's sidebar wrapped around a sign-up card.
  "/invite",
  // The dashboard is its own full-width layout with its own nav; the app
  // sidebar would squeeze its tables and offer navigation to a different app.
  "/admin",
];

/**
 * Picks the layout by route: full-bleed for landing/auth pages, the sidebar
 * shell for everything else. Path-based (not auth-based) so it's correct in
 * local no-auth dev too.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isBare = NO_CHROME_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (isBare) return <main className="public-main">{children}</main>;

  // The watch page is full-bleed (theater video), so it opts out of the
  // centered, padded content column and manages its own layout.
  const isWatch = pathname.startsWith("/watch/");

  return (
    <div className="app-shell">
      <Sidebar />
      {isWatch ? (
        <main className="app-main watch-main">{children}</main>
      ) : (
        <main className="app-main">
          <div className="app-content">{children}</div>
        </main>
      )}
    </div>
  );
}
