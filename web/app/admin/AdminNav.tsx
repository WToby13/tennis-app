"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/members", label: "Members" },
  { href: "/admin/matches", label: "Matches" },
  { href: "/admin/events", label: "Events" },
  { href: "/admin/reports", label: "Reports" },
  { href: "/admin/costs", label: "Costs" },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="admin-nav">
      {TABS.map((t) => {
        // Overview is an exact match; the rest own their subtree, so a member's
        // detail page keeps Members highlighted rather than dropping the tab.
        const active = t.href === "/admin" ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "admin-tab active" : "admin-tab"}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
