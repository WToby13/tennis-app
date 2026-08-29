import Link from "next/link";
import { notFound } from "next/navigation";

import { bytes, duration, when, whenExact } from "@/lib/admin/format";
import { adminDataAvailable, memberDetail } from "@/lib/admin/queries";

/** One member: who they are, what they have uploaded, and what they last did. */
export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  if (!adminDataAvailable()) return null;
  const { id } = await params;
  const d = await memberDetail(id);
  if (!d.member) notFound();

  return (
    <>
      <section className="admin-section">
        <p className="muted">
          <Link href="/admin/members">← Members</Link>
        </p>
        <h2>{d.member.displayName}</h2>
        <p className="muted">{d.email ?? "email unavailable"}</p>

        <div className="stat-grid" style={{ marginTop: 12 }}>
          <Stat label="Matches" value={d.member.matches} />
          <Stat label="Stored" value={d.member.storageBytes ? bytes(d.member.storageBytes) : "—"} />
          <Stat label="Followers" value={d.followers} />
          <Stat label="Following" value={d.following} />
          <Stat label="Joined" value={when(d.member.createdAt)} />
        </div>
      </section>

      <section className="admin-section">
        <h2>Their matches</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Recorded</th>
                <th className="num">Length</th>
                <th className="num">Size</th>
                <th>Upload</th>
                <th>Analysis</th>
                <th>Visibility</th>
              </tr>
            </thead>
            <tbody>
              {d.matches.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td>{when(m.createdAt)}</td>
                  <td className="num">{duration(m.durationS)}</td>
                  <td className="num">{bytes(m.sizeBytes)}</td>
                  <td>
                    <span className={`pill ${m.status === "ready" ? "ok" : "warn"}`}>{m.status}</span>
                  </td>
                  <td>
                    <AnalysisPill status={m.analysisStatus} />
                  </td>
                  <td className="muted">{m.visibility ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.matches.length === 0 && <p className="admin-empty">No matches uploaded.</p>}
        </div>
      </section>

      <section className="admin-section">
        <h2>Recent activity</h2>
        <p className="muted">Last 50 product events attributed to this account.</p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Platform</th>
              </tr>
            </thead>
            <tbody>
              {d.recentEvents.map((e, i) => (
                <tr key={`${e.occurredAt}-${i}`}>
                  <td>{whenExact(e.occurredAt)}</td>
                  <td className="mono">{e.name}</td>
                  <td className="muted">{e.platform}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.recentEvents.length === 0 && (
            <p className="admin-empty">
              No events recorded. Either they have not used it since analytics shipped, or they
              have turned off usage sharing.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function AnalysisPill({ status }: { status: string | null }) {
  if (!status || status === "none") return <span className="muted">—</span>;
  const tone = status === "ready" ? "ok" : status === "failed" ? "bad" : "warn";
  return <span className={`pill ${tone}`}>{status}</span>;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
    </div>
  );
}
