"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";

/** Paths that render without the app chrome (marketing + auth). */
const PUBLIC_PREFIXES = ["/landing", "/sign-in", "/sign-up", "/login"];

/**
 * Picks the layout by route: full-bleed for landing/auth pages, the sidebar
 * shell for everything else. Path-based (not auth-based) so it's correct in
 * local no-auth dev too.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (isPublic) return <main className="public-main">{children}</main>;

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-main">
        <div className="app-content">{children}</div>
      </main>
    </div>
  );
}
