"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The actions on one report, with the row refreshing from the server afterwards
 * rather than being patched locally — the list is ordered by resolved state, so
 * the row moves, and guessing where it lands would be a second source of truth.
 *
 * Three of them, because Guideline 1.2 asks the developer to "act on
 * objectionable content reports within 24 hours by removing the content and
 * ejecting the user": Remove and Eject are those two, and Resolve stays for the
 * outcome the guideline does not cover — looked at it, nothing to do.
 *
 * Remove and Eject both confirm first. They are destructive, they are one click
 * apart, and the row says who is about to be ejected.
 */
export function ReportActions({
  id,
  resolved,
  reportedName,
  targetKind,
  canEject,
}: {
  id: string;
  resolved: boolean;
  reportedName: string;
  targetKind: string;
  canEject: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function post(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setError(null);
    try {
      const res = await fetch(`/api/admin/reports/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? String(res.status));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Try again");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="report-actions">
      {!resolved && (
        <>
          <button
            className="btn danger btn-sm"
            disabled={busy !== null}
            title={`Take this ${targetKind} down for everyone`}
            onClick={() => {
              if (confirm(`Remove this ${targetKind}? It stops being visible to anyone.`)) {
                void post({ action: "remove" }, "remove");
              }
            }}
          >
            {busy === "remove" ? "…" : "Remove"}
          </button>

          {canEject && (
            <button
              className="btn danger btn-sm"
              disabled={busy !== null}
              title="Ban the account that posted it"
              onClick={() => {
                if (confirm(`Eject ${reportedName}? They will not be able to sign in again.`)) {
                  void post({ action: "eject" }, "eject");
                }
              }}
            >
              {busy === "eject" ? "…" : "Eject"}
            </button>
          )}
        </>
      )}

      <button
        className={resolved ? "btn secondary btn-sm" : "btn btn-sm"}
        disabled={busy !== null}
        title={resolved ? "Move back to the open queue" : "Mark as actioned, changing nothing"}
        onClick={() => void post({ resolved: !resolved }, "resolve")}
      >
        {busy === "resolve" ? "…" : resolved ? "Reopen" : "Resolve"}
      </button>

      {error && <span className="report-actions-error">{error}</span>}
    </div>
  );
}
