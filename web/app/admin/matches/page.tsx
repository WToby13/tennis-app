import Link from "next/link";

import { bytes, duration, when } from "@/lib/admin/format";
import { adminDataAvailable, matches } from "@/lib/admin/queries";

/**
 * Video processing. Two pipelines run over every match — the upload, then the
 * AI analysis — and each can stall independently, so both get a column. The
 * summary counts at the top are the ones worth glancing at; the table is for
 * finding the specific match behind a number.
 */
export default async function MatchesPage() {
  if (!adminDataAvailable()) return null;
  const rows = await matches();

  const uploading = rows.filter((m) => m.status !== "ready").length;
  const analysing = rows.filter(
    (m) => m.analysisStatus && !["ready", "failed", "none"].includes(m.analysisStatus),
  ).length;
  const failed = rows.filter((m) => m.analysisStatus === "failed");

  return (
    <>
      <section className="admin-section">
        <h2>Processing</h2>
        <p className="muted">Most recent 500 matches.</p>
        <div className="stat-grid">
          <Stat label="Live matches" value={rows.length} />
          <Stat label="Uploading" value={uploading} tone={uploading > 0 ? "alert" : undefined} />
          <Stat label="Analysing" value={analysing} />
          <Stat
            label="Analysis failed"
            value={failed.length}
            tone={failed.length > 0 ? "alert" : "good"}
          />
        </div>
      </section>

      {failed.length > 0 && (
        <section className="admin-section">
          <h2>Failures</h2>
          <p className="muted">
            The error text comes from the analysis runner. A size limit means the proxy
            transcode did not shrink it far enough; anything else is worth reading in full.
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Owner</th>
                  <th className="num">Size</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {failed.map((m) => (
                  <tr key={m.id}>
                    <td>{m.title}</td>
                    <td>
                      <Link href={`/admin/members/${m.ownerId}`}>{m.ownerName}</Link>
                    </td>
                    <td className="num">{bytes(m.sizeBytes)}</td>
                    <td className="report-body">{m.analysisError ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="admin-section">
        <h2>All matches</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Owner</th>
                <th>Recorded</th>
                <th className="num">Length</th>
                <th className="num">Size</th>
                <th>Upload</th>
                <th>Analysis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td>
                    {m.ownerId ? (
                      <Link href={`/admin/members/${m.ownerId}`}>{m.ownerName}</Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{when(m.createdAt)}</td>
                  <td className="num">{duration(m.durationS)}</td>
                  <td className="num">{bytes(m.sizeBytes)}</td>
                  <td>
                    <span className={`pill ${m.status === "ready" ? "ok" : "warn"}`}>
                      {m.status}
                    </span>
                  </td>
                  <td>
                    {!m.analysisStatus || m.analysisStatus === "none" ? (
                      <span className="muted">—</span>
                    ) : (
                      <span
                        className={`pill ${
                          m.analysisStatus === "ready"
                            ? "ok"
                            : m.analysisStatus === "failed"
                              ? "bad"
                              : "warn"
                        }`}
                      >
                        {m.analysisStatus}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="admin-empty">No matches yet.</p>}
        </div>
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone?: "alert" | "good";
}) {
  return (
    <div className={tone ? `stat ${tone}` : "stat"}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
    </div>
  );
}
