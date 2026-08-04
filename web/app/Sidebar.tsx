"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Nav icons, sized to match the 28px logo tile (see .rail .navlink svg). */
const icons = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 9.5V20h14V9.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  matches: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" strokeLinecap="round" />
    </svg>
  ),
  profile: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20c0-3.6 3.4-6 7.5-6s7.5 2.4 7.5 6" strokeLinecap="round" />
    </svg>
  ),
};

const NAV = [
  { href: "/", label: "Home", icon: icons.home },
  { href: "/matches", label: "Matches", icon: icons.matches },
  { href: "/upload", label: "Upload", icon: icons.upload },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <aside className="app-sidebar">
      <div className="rail">
        <Link href="/" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="" width={28} height={28} />
          <span className="word">Ojo Tennis</span>
        </Link>

        <nav aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`navlink ${isActive(item.href) ? "active" : ""}`}
              title={item.label}
            >
              {item.icon}
              <span className="label">{item.label}</span>
            </Link>
          ))}
        </nav>

        <div className="spacer" />

        <nav aria-label="Account">
          <Link
            href="/profile"
            className={`navlink ${isActive("/profile") ? "active" : ""}`}
            title="Profile"
          >
            {icons.profile}
            <span className="label">Profile</span>
          </Link>
        </nav>
      </div>
    </aside>
  );
}
