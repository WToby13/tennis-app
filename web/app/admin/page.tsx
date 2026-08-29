import Link from "next/link";

import { bytes, whenExact } from "@/lib/admin/format";
import { adminDataAvailable, matches, overview, reports } from "@/lib/admin/queries";

/**
 * The overview answers one question: is anything wrong right now?
 *
 * So the tiles that can go red — failed analyses, open reports — are the point
 * of the page, and the growth numbers are context. Anything alarming links
 * straight to the page that can act on it; a dashboard that reports a problem
 * without offering the next click just makes you go looking.
 */
export default async function AdminOverview() {
  if (!adminDataAvailable()) return null;

  const [o, allReports, allMatches] = await Promise.all([overview(), reports(), matches()]);
  const open = allReports.filter((r) => !r.resolvedAt);
  const failed = allMatches.filter((m) => m.analysisStatus === "failed").slice(0, 5);

  return (
    <>
      <section className="admin-section">
        <h2>Right now</h2>
        <p className="muted">Anything in red wants attention.</p>
        <div className="stat-grid">
          <Stat
            label="Open reports"
            value={o.openReports}
            tone={o.openReports > 0 ? "alert" : "good"}
            sub={o.openReports > 0 ? "listing promises 24h" : "nothing outstanding"}
          />
          <Stat
            label="Analysis failed"
            value={o.analysisFailed}
            tone={o.analysisFailed > 0 ? "alert" : undefined}
            sub="needs a retry"
          />
          <Stat
            label="Uploads in flight"
            value={o.uploadsInFlight}
            sub="not yet playable"
          />
          <Stat label="Events, 7d" value={o.eventsThisWeek} sub="analytics still arriving" />
        </div>
      </section>

      <section className="admin-section">
        <h2>Size of the thing</h2>
        <div className="stat-grid">
          <Stat label="Members" value={o.members} sub={`+${o.membersThisWeek} this week`} />
          <Stat label="Matches" value={o.matches} sub={`+${o.matchesThisWeek} this week`} />
          <Stat label="Analysed" value={o.analysedMatches} sub="with a rally breakdown" />
          <Stat label="Stored" value={bytes(o.storageBytes)} sub="S3, live matches" />
        </div>
      </section>

      {open.length > 0 && (
        <section className="admin-section">
          <h2>Reports waiting</h2>
          <p className="muted">
            Oldest first. <Link href="/admin/reports">Resolve them →</Link>
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Filed</th>
                  <th>Reason</th>
                  <th>On</th>
                  <th>Content</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 5).map((r) => (
                  <tr key={r.id}>
                    <td>{whenExact(r.createdAt)}</td>
                    <td>
                      <span className="pill warn">{r.reason}</span>
                    </td>
                    <td>{r.targetKind}</td>
                    <td className="report-body">{r.contentSnapshot ?? "—"}</td>
                    <td>{r.reportedName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {failed.length > 0 && (
        <section className="admin-section">
          <h2>Analyses that failed</h2>
          <p className="muted">
            The error is the server&rsquo;s own words. <Link href="/admin/matches">All matches →</Link>
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Owner</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((m) => (
                  <tr key={m.id}>
                    <td>{m.title}</td>
                    <td>{m.ownerName}</td>
                    <td className="report-body">{m.analysisError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: number | string;
  sub?: string;
  tone?: "alert" | "good";
}) {
  return (
    <div className={tone ? `stat ${tone}` : "stat"}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
}
