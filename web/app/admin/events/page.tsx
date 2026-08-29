import { adminDataAvailable, eventRollup, metricsViews } from "@/lib/admin/queries";

/**
 * Event tracking, and the four numbers GTM §6 says are the only ones that
 * matter yet.
 *
 * The views come from 0019 and are rendered generically — whatever columns they
 * return get a column here. That is deliberate: the definitions live in SQL
 * where they can be reasoned about, and this page should not become a second
 * place where a metric is defined slightly differently.
 */
const VIEW_TITLES: Record<string, { title: string; blurb: string }> = {
  metrics_share_rate: {
    title: "Share rate",
    blurb: "Matches shared ÷ matches uploaded, by upload week. The loop's input.",
  },
  metrics_share_conversion: {
    title: "Share conversion",
    blurb: "Recipients who created an account ÷ links opened. The loop's multiplier.",
  },
  metrics_second_watch: {
    title: "Second watch",
    blurb: "Matches watched again a day or more later. The honest retention signal.",
  },
  metrics_recording_retention: {
    title: "Recording retention",
    blurb: "Whether recording became a habit rather than a one-off.",
  },
  metrics_upload_reliability: {
    title: "Upload reliability",
    blurb: "Completions, failures and part retries — how well long uploads survive.",
  },
};

export default async function EventsPage() {
  if (!adminDataAvailable()) return null;
  const [{ rollup, daily }, views] = await Promise.all([eventRollup(), metricsViews()]);

  const peak = Math.max(1, ...daily.map((d) => d.n));

  return (
    <>
      <section className="admin-section">
        <h2>Events per day</h2>
        <p className="muted">Last 30 days with any activity. Peak {peak}/day.</p>
        <div className="stat" style={{ padding: "16px 18px" }}>
          <div className="spark">
            {daily.map((d) => (
              <div
                key={d.day}
                className="spark-bar"
                style={{ height: `${Math.max(3, (d.n / peak) * 100)}%` }}
                title={`${d.day}: ${d.n}`}
              />
            ))}
          </div>
          {daily.length === 0 && <p className="admin-empty">No events recorded yet.</p>}
        </div>
      </section>

      <section className="admin-section">
        <h2>By event</h2>
        <p className="muted">
          The full list is <span className="mono">web/lib/analytics/events.ts</span>; anything not
          on it is rejected by the API, so this is the whole truth rather than a sample.
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Event</th>
                <th className="num">Total</th>
                <th className="num">Last 7d</th>
                <th className="num">Web</th>
                <th className="num">iOS</th>
              </tr>
            </thead>
            <tbody>
              {rollup.map((e) => (
                <tr key={e.name}>
                  <td className="mono">{e.name}</td>
                  <td className="num">{e.total}</td>
                  <td className="num">{e.last7}</td>
                  <td className="num">{e.web}</td>
                  <td className="num">{e.ios}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rollup.length === 0 && <p className="admin-empty">No events recorded yet.</p>}
        </div>
      </section>

      {Object.entries(VIEW_TITLES).map(([key, meta]) => (
        <section className="admin-section" key={key}>
          <h2>{meta.title}</h2>
          <p className="muted">{meta.blurb}</p>
          <ViewTable rows={views[key] ?? []} />
        </section>
      ))}
    </>
  );
}

/** Renders whatever shape the SQL view returns, so the two can't drift. */
function ViewTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  if (rows.length === 0) {
    return (
      <div className="admin-table-wrap">
        <p className="admin-empty">Not enough data yet.</p>
      </div>
    );
  }
  const cols = Object.keys(rows[0]);
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c.replace(/_/g, " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => {
                const v = r[c];
                const numeric = typeof v === "number";
                return (
                  <td key={c} className={numeric ? "num" : undefined}>
                    {v == null ? "—" : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
