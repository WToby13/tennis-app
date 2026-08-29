import Link from "next/link";

import { whenExact } from "@/lib/admin/format";
import { adminDataAvailable, reports } from "@/lib/admin/queries";

import { ResolveButton } from "./ResolveButton";

/**
 * The moderation queue. Open reports first, oldest at the top, because the App
 * Store listing and the Terms both commit to acting within 24 hours and the
 * oldest one is the one closest to breaking that promise.
 *
 * Resolving does not delete anything. A report is the record of a decision, and
 * "looked at it, nothing to do" is a legitimate outcome that should still leave
 * a trace — which is also why reopening is possible.
 */
export default async function ReportsPage() {
  if (!adminDataAvailable()) return null;
  const rows = await reports();
  const open = rows.filter((r) => !r.resolvedAt);
  const done = rows.filter((r) => r.resolvedAt);

  return (
    <>
      <section className="admin-section">
        <h2>Open reports</h2>
        <p className="muted">
          {open.length === 0
            ? "Nothing outstanding."
            : `${open.length} waiting. The listing commits to reviewing within 24 hours.`}
        </p>
        <ReportTable rows={open} />
      </section>

      <section className="admin-section">
        <h2>Resolved</h2>
        <p className="muted">
          Kept as the record of what was decided, and by when.
        </p>
        <ReportTable rows={done} />
      </section>
    </>
  );
}

function ReportTable({
  rows,
}: {
  rows: Awaited<ReturnType<typeof reports>>;
}) {
  if (rows.length === 0) {
    return (
      <div className="admin-table-wrap">
        <p className="admin-empty">Nothing here.</p>
      </div>
    );
  }

  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Filed</th>
            <th>Reason</th>
            <th>On</th>
            <th>Content as reported</th>
            <th>Reported user</th>
            <th>By</th>
            <th>Resolved</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{whenExact(r.createdAt)}</td>
              <td>
                <span className={`pill ${r.resolvedAt ? "" : "warn"}`}>{r.reason}</span>
              </td>
              <td>
                {r.targetKind}
                <br />
                <span className="mono-id">{r.targetId.slice(0, 8)}</span>
              </td>
              <td className="report-body">
                {r.contentSnapshot ?? <span className="muted">—</span>}
                {r.details && (
                  <>
                    <br />
                    <em>{r.details}</em>
                  </>
                )}
              </td>
              <td>
                {r.reportedUserId ? (
                  <Link href={`/admin/members/${r.reportedUserId}`}>{r.reportedName}</Link>
                ) : (
                  <span className="muted">{r.reportedName}</span>
                )}
              </td>
              <td className="muted">{r.reporterName}</td>
              <td className="muted">{r.resolvedAt ? whenExact(r.resolvedAt) : "—"}</td>
              <td>
                <ResolveButton id={r.id} resolved={Boolean(r.resolvedAt)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
