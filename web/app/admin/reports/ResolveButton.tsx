"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Resolve or reopen, with the row refreshing from the server afterwards rather
 * than being patched locally — the list is ordered by resolved state, so the row
 * moves, and guessing where it lands would be a second source of truth.
 */
export function ResolveButton({ id, resolved }: { id: string; resolved: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function toggle() {
    setBusy(true);
    setError(false);
    try {
      const res = await fetch(`/api/admin/reports/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolved: !resolved }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.refresh();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className={resolved ? "btn secondary btn-sm" : "btn btn-sm"}
      onClick={toggle}
      disabled={busy}
      title={resolved ? "Move back to the open queue" : "Mark as actioned"}
    >
      {busy ? "…" : error ? "Try again" : resolved ? "Reopen" : "Resolve"}
    </button>
  );
}
