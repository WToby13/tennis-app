import Link from "next/link";

import { ago, bytes, when } from "@/lib/admin/format";
import { adminDataAvailable, members } from "@/lib/admin/queries";

/**
 * Everyone, newest first. Sorted by sign-up rather than activity because the
 * question this page usually answers is "did the people I gave it to last week
 * actually record anything" — and that reads best chronologically.
 */
export default async function MembersPage() {
  if (!adminDataAvailable()) return null;
  const rows = await members();

  const active = rows.filter((m) => m.matches > 0).length;

  return (
    <section className="admin-section">
      <h2>Members</h2>
      <p className="muted">
        {rows.length} account{rows.length === 1 ? "" : "s"}, {active} with at least one match.
        Click a name for their matches and activity.
      </p>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Joined</th>
              <th className="num">Matches</th>
              <th className="num">Stored</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link href={`/admin/members/${m.id}`}>{m.displayName}</Link>
                </td>
                <td>{when(m.createdAt)}</td>
                <td className="num">{m.matches || <span className="muted">0</span>}</td>
                <td className="num">{m.storageBytes ? bytes(m.storageBytes) : "—"}</td>
                <td>{ago(m.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="admin-empty">No accounts yet.</p>}
      </div>
    </section>
  );
}
