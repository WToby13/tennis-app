import { money } from "@/lib/admin/format";
import { costs } from "@/lib/admin/costs";
import { adminDataAvailable } from "@/lib/admin/queries";

/**
 * Costs, with the line between measured and assumed drawn in the open.
 *
 * Usage is real — gigabytes and minutes are rows in the database. Prices are
 * whatever the environment says they are. Egress is absent on purpose: it is
 * usually the largest AWS line on a video product and there is no honest way to
 * derive it from anything stored here.
 */
export default async function CostsPage() {
  if (!adminDataAvailable()) return null;
  const c = await costs();

  return (
    <>
      <section className="admin-section">
        <h2>Estimated monthly</h2>
        <p className="muted">
          Measured usage × the rates below. An estimate of the recurring part, not a bill.
        </p>
        <div className="stat-grid">
          <Stat label="Storage / month" value={money(c.storageMonthly, c.currency)} sub={`${c.storageGb.toFixed(1)} GB`} />
          <Stat
            label="Analysis this month"
            value={money(c.analysisThisMonth, c.currency)}
            sub="billed once, when it runs"
          />
          {c.fixedMonthly > 0 && (
            <Stat label="Fixed" value={money(c.fixedMonthly, c.currency)} sub="hosting, set manually" />
          )}
          <Stat
            label="Recurring total"
            value={money(c.estimatedMonthly, c.currency)}
            sub="excludes egress"
          />
        </div>
      </section>

      <section className="admin-section">
        <h2>What drives it</h2>
        <div className="stat-grid">
          <Stat label="Stored" value={`${c.storageGb.toFixed(1)} GB`} sub="live matches in S3" />
          <Stat label="Analysis proxies" value={c.proxyCount} sub="extra objects held" />
          <Stat
            label="Analysed"
            value={`${Math.round(c.analysedMinutes).toLocaleString()} min`}
            sub={`${c.analysedMatches} matches, all time`}
          />
          <Stat
            label="Analysis, all time"
            value={money(c.analysisTotal, c.currency)}
            sub="sunk, not recurring"
          />
        </div>
      </section>

      <section className="admin-section">
        <h2>Egress is not shown</h2>
        <div className="stat" style={{ padding: "16px 18px" }}>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>
            CloudFront bills bytes actually transferred, and nothing recorded here knows that
            number. A viewer who scrubs to three rallies of a 3&nbsp;GB match transfers a
            fraction of it, so any figure derived from playback counts would be invented — and
            it would be the most-quoted number on this page. On a video product it is usually
            the largest AWS line, so it is worth checking in the AWS billing console directly
            rather than being guessed at here.
          </p>
        </div>
      </section>

      <section className="admin-section">
        <h2>Largest matches</h2>
        <p className="muted">Where the storage actually goes.</p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Match</th>
                <th className="num">Size</th>
                <th className="num">Length</th>
              </tr>
            </thead>
            <tbody>
              {c.biggest.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td className="num">{m.gb.toFixed(2)} GB</td>
                  <td className="num">{m.minutes == null ? "—" : `${Math.round(m.minutes)} min`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {c.biggest.length === 0 && <p className="admin-empty">No matches stored.</p>}
        </div>
      </section>

      <section className="admin-section">
        <h2>Rates in use</h2>
        <p className="muted">
          Set these in the environment so the estimate tracks what you are actually charged.
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Variable</th>
                <th className="num">Value</th>
                <th>What it prices</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">COST_S3_PER_GB_MONTH</td>
                <td className="num">{c.rates.s3PerGbMonth}</td>
                <td className="muted">S3 storage per GB per month</td>
              </tr>
              <tr>
                <td className="mono">COST_ANALYSIS_PER_MINUTE</td>
                <td className="num">{c.rates.analysisPerMinute}</td>
                <td className="muted">TwelveLabs per minute of video analysed</td>
              </tr>
              <tr>
                <td className="mono">COST_FIXED_MONTHLY</td>
                <td className="num">{c.rates.fixedMonthly}</td>
                <td className="muted">Vercel, Supabase and anything else flat</td>
              </tr>
              <tr>
                <td className="mono">COST_CURRENCY</td>
                <td className="num">{c.rates.currency}</td>
                <td className="muted">Display only; no conversion is done</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
}
