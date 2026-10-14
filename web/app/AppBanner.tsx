"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { APP_STORE_URL, appLink } from "@/lib/site";

/**
 * "Open in the app" for people on an iPhone, in the browsers that don't show
 * Safari's own Smart App Banner (layout.tsx): Chrome, Firefox and the in-app
 * browsers of WhatsApp, Instagram and the like, which is where shared links
 * usually open. "Open" takes them to the same place in the app (a match, with
 * its share token); "Get" to the App Store.
 *
 * A page can't tell whether the app is installed, so both are offered rather
 * than guessing with a timed fallback (which on iOS fires under the "Open in
 * Ojo?" prompt). Closed, it stays closed for the visit.
 */

const DISMISSED = "ojo-app-banner-dismissed";

/** Only on an iPhone, and not in Safari (which has its own banner). */
function wanted(): boolean {
  const ua = navigator.userAgent;
  if (!/iPhone|iPod/.test(ua)) return false;
  const otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram|LinkedInApp|Snapchat|WhatsApp|Line\//.test(ua);
  const safari = /Version\/[\d.]+.*Safari\//.test(ua) && !otherBrowser;
  if (safari) return false;
  try {
    return sessionStorage.getItem(DISMISSED) !== "1";
  } catch {
    return true;
  }
}

export function AppBanner() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [show, setShow] = useState(false);
  useEffect(() => setShow(wanted()), []);
  if (!show || pathname.startsWith("/admin")) return null;

  const isMatch = pathname.startsWith("/watch/");
  const close = () => {
    setShow(false);
    try {
      sessionStorage.setItem(DISMISSED, "1");
    } catch {
      // Private mode: closed for this page only.
    }
  };

  return (
    <div className="app-banner" role="region" aria-label="Ojo Tennis app">
      <button className="app-banner-close" onClick={close} aria-label="Close">
        ×
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="app-banner-icon" src="/apple-icon.png" alt="" width={40} height={40} />
      <div className="app-banner-text">
        <strong>Ojo Tennis</strong>
        <span>{isMatch ? "Watch it in the app" : "Free on the App Store"}</span>
      </div>
      <a className="btn app-banner-open" href={appLink(pathname, search.get("s"))}>
        Open
      </a>
      <a className="btn secondary app-banner-get" href={APP_STORE_URL} target="_blank" rel="noreferrer">
        Get
      </a>
    </div>
  );
}
