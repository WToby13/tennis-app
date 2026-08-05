"use client";

import { useState } from "react";
import { ShareIcon } from "./icons";

/** Mint a revocable share link for a video and copy it to the clipboard. */
export function ShareButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn secondary btn-sm"
      onClick={async () => {
        let url = `${window.location.origin}/watch/${id}`;
        try {
          const res = await fetch(`/api/videos/${id}/share`, { method: "POST" });
          if (res.ok) {
            const { path } = await res.json();
            url = `${window.location.origin}${path}`;
          }
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          window.prompt("Copy this link to share:", url);
        }
      }}
    >
      <ShareIcon size={16} />
      {copied ? "Copied" : "Share"}
    </button>
  );
}
