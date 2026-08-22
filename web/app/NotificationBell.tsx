"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BellIcon } from "./icons";

/**
 * The rail's bell, carrying the unread count.
 *
 * Polled rather than pushed: a tab left open all afternoon should pick up a new
 * tag, and a minute of latency is nothing against how a comment thread actually
 * moves. It also refreshes on focus, which is what covers the common case of
 * coming back to the tab after being tagged somewhere else.
 */
export function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications");
      if (res.ok) setUnread((await res.json()).unreadCount ?? 0);
    } catch {
      /* offline or signed out — leave the badge as it was */
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
    // Re-runs on navigation so the badge clears as soon as the inbox is opened.
  }, [refresh, pathname]);

  return (
    <Link
      href="/notifications"
      className={`navlink ${pathname.startsWith("/notifications") ? "active" : ""}`}
      title="Notifications"
    >
      <span className="navlink-icon">
        <BellIcon />
        {unread > 0 && <span className="nav-badge">{unread > 9 ? "9+" : unread}</span>}
      </span>
      <span className="label">Notifications</span>
    </Link>
  );
}
