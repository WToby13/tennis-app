import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { currentAdmin } from "@/lib/admin/guard";
import { adminDataAvailable } from "@/lib/admin/queries";

import { AdminNav } from "./AdminNav";
import "./admin.css";

/**
 * `noindex` belongs here even though the pages are behind auth. Search engines
 * never see them, but link previews and browser history do, and an operator
 * dashboard has no business being anywhere quotable.
 */
export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

/** Always live: a dashboard showing yesterday's numbers is worse than none. */
export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await currentAdmin();

  // `notFound()`, not a redirect or a 403. A 403 confirms the route exists and
  // that someone is behind it; a 404 tells an unauthorised visitor exactly what
  // a nonexistent path would. Nothing here is worth confirming to a stranger.
  if (!admin) notFound();

  return (
    <div className="admin">
      <header className="admin-head">
        <div>
          <Link className="admin-brand" href="/admin">
            Ojo <span>admin</span>
          </Link>
          <p className="admin-who muted">{admin}</p>
        </div>
        <Link className="btn secondary btn-sm" href="/">
          Back to app
        </Link>
      </header>

      <AdminNav />

      {!adminDataAvailable() && (
        <div className="admin-warn">
          <strong>SUPABASE_SERVICE_ROLE_KEY is not set.</strong> Every panel below reads
          across all accounts, which needs the service role. Nothing will load until it is
          set in the environment.
        </div>
      )}

      <main className="admin-main">{children}</main>
    </div>
  );
}
