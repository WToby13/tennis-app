import { getSupabaseServiceRole, serviceRoleConfigured } from "../supabase/service";

/**
 * Every read behind /admin.
 *
 * All of it runs on the **service role**, which is the only way to answer
 * "how many people signed up this week" — every other path in this app is
 * RLS-scoped to the caller by design, and an operator asking about other
 * people's rows is exactly the case RLS is there to refuse. The guard in
 * `guard.ts` is what makes that safe: the key is only ever reached after the
 * session email has been matched against ADMIN_EMAIL.
 *
 * Read-only apart from `resolveReport`.
 */

export interface Overview {
  members: number;
  membersThisWeek: number;
  matches: number;
  matchesThisWeek: number;
  storageBytes: number;
  analysedMatches: number;
  analysisFailed: number;
  uploadsInFlight: number;
  openReports: number;
  eventsThisWeek: number;
}

/** Nothing here works without the service role; say so rather than half-render. */
export function adminDataAvailable(): boolean {
  return serviceRoleConfigured();
}

export async function overview(): Promise<Overview> {
  const db = getSupabaseServiceRole();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();

  // `head: true` means Postgres counts and no rows cross the wire — which starts
  // to matter as soon as `videos` has a few thousand rows.
  const head = { count: "exact" as const, head: true };

  const [
    members,
    membersThisWeek,
    matches,
    matchesThisWeek,
    analysedMatches,
    analysisFailed,
    uploadsInFlight,
    openReports,
    eventsThisWeek,
    sizes,
  ] = await Promise.all([
    db.from("profiles").select("*", head),
    db.from("profiles").select("*", head).gte("created_at", since),
    db.from("videos").select("*", head).is("deleted_at", null),
    db.from("videos").select("*", head).is("deleted_at", null).gte("created_at", since),
    db.from("videos").select("*", head).is("deleted_at", null).eq("analysis_status", "ready"),
    db.from("videos").select("*", head).is("deleted_at", null).eq("analysis_status", "failed"),
    db.from("videos").select("*", head).is("deleted_at", null).neq("status", "ready"),
    db.from("content_reports").select("*", head).is("resolved_at", null),
    db.from("events").select("*", head).gte("occurred_at", since),
    db.from("videos").select("size_bytes").is("deleted_at", null),
  ]);

  const storageBytes = ((sizes.data ?? []) as Array<{ size_bytes: number | null }>).reduce(
    (sum, r) => sum + Number(r.size_bytes ?? 0),
    0,
  );

  return {
    members: members.count ?? 0,
    membersThisWeek: membersThisWeek.count ?? 0,
    matches: matches.count ?? 0,
    matchesThisWeek: matchesThisWeek.count ?? 0,
    storageBytes,
    analysedMatches: analysedMatches.count ?? 0,
    analysisFailed: analysisFailed.count ?? 0,
    uploadsInFlight: uploadsInFlight.count ?? 0,
    openReports: openReports.count ?? 0,
    eventsThisWeek: eventsThisWeek.count ?? 0,
  };
}

export interface Member {
  id: string;
  displayName: string;
  createdAt: string | null;
  matches: number;
  storageBytes: number;
  lastSeen: string | null;
}

/**
 * Everyone, with the two numbers that say whether they actually use it: how
 * many matches they own, and when they were last seen doing anything.
 *
 * Three queries rather than a join because PostgREST cannot aggregate across a
 * relationship, and at this size folding them together in memory is faster than
 * a view would be to maintain.
 */
export async function members(): Promise<Member[]> {
  const db = getSupabaseServiceRole();

  const [{ data: profiles }, { data: videos }, { data: lastEvents }] = await Promise.all([
    db.from("profiles").select("id, display_name, first_name, last_name, created_at"),
    db.from("videos").select("owner_id, size_bytes").is("deleted_at", null),
    db.from("events").select("user_id, occurred_at").order("occurred_at", { ascending: false }).limit(5000),
  ]);

  const byOwner = new Map<string, { n: number; bytes: number }>();
  for (const v of (videos ?? []) as Array<{ owner_id: string | null; size_bytes: number | null }>) {
    if (!v.owner_id) continue;
    const cur = byOwner.get(v.owner_id) ?? { n: 0, bytes: 0 };
    cur.n += 1;
    cur.bytes += Number(v.size_bytes ?? 0);
    byOwner.set(v.owner_id, cur);
  }

  // The events query is already newest-first, so the first hit per user wins.
  const seen = new Map<string, string>();
  for (const e of (lastEvents ?? []) as Array<{ user_id: string | null; occurred_at: string }>) {
    if (e.user_id && !seen.has(e.user_id)) seen.set(e.user_id, e.occurred_at);
  }

  return ((profiles ?? []) as Array<{
    id: string;
    display_name: string | null;
    first_name: string | null;
    last_name: string | null;
    created_at: string | null;
  }>)
    .map((p) => ({
      id: p.id,
      displayName:
        p.display_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Ojo player",
      createdAt: p.created_at,
      matches: byOwner.get(p.id)?.n ?? 0,
      storageBytes: byOwner.get(p.id)?.bytes ?? 0,
      lastSeen: seen.get(p.id) ?? null,
    }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export interface MemberDetail {
  member: Member | null;
  email: string | null;
  matches: AdminMatch[];
  recentEvents: Array<{ name: string; platform: string; occurredAt: string; videoId: string | null }>;
  followers: number;
  following: number;
}

export async function memberDetail(id: string): Promise<MemberDetail> {
  const db = getSupabaseServiceRole();

  const [all, { data: vids }, { data: evs }, email, followers, following] =
    await Promise.all([
      members(),
      db
        .from("videos")
        .select("id, title, owner_id, size_bytes, duration_s, status, analysis_status, analysis_error, created_at, visibility")
        .eq("owner_id", id)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      db
        .from("events")
        .select("name, platform, occurred_at, video_id")
        .eq("user_id", id)
        .order("occurred_at", { ascending: false })
        .limit(50),
      db.auth.admin
        .getUserById(id)
        .then((r) => r.data?.user?.email ?? null)
        // An account deleted between the list load and this lookup is normal,
        // not exceptional — the page still renders, just without an address.
        .catch(() => null),
      db.from("follows").select("*", { count: "exact", head: true }).eq("followee_id", id),
      db.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", id),
    ]);

  return {
    member: all.find((m) => m.id === id) ?? null,
    email,
    matches: toMatches(vids ?? []),
    recentEvents: ((evs ?? []) as Array<{
      name: string;
      platform: string;
      occurred_at: string;
      video_id: string | null;
    }>).map((e) => ({
      name: e.name,
      platform: e.platform,
      occurredAt: e.occurred_at,
      videoId: e.video_id,
    })),
    followers: followers.count ?? 0,
    following: following.count ?? 0,
  };
}

export interface AdminMatch {
  id: string;
  title: string;
  ownerId: string | null;
  sizeBytes: number;
  durationS: number | null;
  status: string;
  analysisStatus: string | null;
  analysisError: string | null;
  createdAt: string;
  visibility: string | null;
}

function toMatches(rows: unknown[]): AdminMatch[] {
  return (rows as Array<Record<string, unknown>>).map((v) => ({
    id: String(v.id),
    title: String(v.title ?? "Untitled match"),
    ownerId: (v.owner_id as string) ?? null,
    sizeBytes: Number(v.size_bytes ?? 0),
    durationS: v.duration_s == null ? null : Number(v.duration_s),
    status: String(v.status ?? "unknown"),
    analysisStatus: (v.analysis_status as string) ?? null,
    analysisError: (v.analysis_error as string) ?? null,
    createdAt: String(v.created_at),
    visibility: (v.visibility as string) ?? null,
  }));
}

/** Every live match, newest first, with the owner's name resolved. */
export async function matches(): Promise<Array<AdminMatch & { ownerName: string }>> {
  const db = getSupabaseServiceRole();
  const [{ data: vids }, { data: profiles }] = await Promise.all([
    db
      .from("videos")
      .select("id, title, owner_id, size_bytes, duration_s, status, analysis_status, analysis_error, created_at, visibility")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(500),
    db.from("profiles").select("id, display_name, first_name, last_name"),
  ]);

  const names = new Map(
    ((profiles ?? []) as Array<{
      id: string;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>).map((p) => [
      p.id,
      p.display_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Ojo player",
    ]),
  );

  return toMatches(vids ?? []).map((m) => ({
    ...m,
    ownerName: (m.ownerId && names.get(m.ownerId)) || "—",
  }));
}

export interface AdminReport {
  id: string;
  createdAt: string;
  resolvedAt: string | null;
  reason: string;
  targetKind: string;
  targetId: string;
  contentSnapshot: string | null;
  details: string | null;
  reporterName: string;
  reportedName: string;
  reportedUserId: string | null;
}

export async function reports(): Promise<AdminReport[]> {
  const db = getSupabaseServiceRole();
  const [{ data: rows }, { data: profiles }] = await Promise.all([
    db
      .from("content_reports")
      .select("*")
      .order("resolved_at", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(500),
    db.from("profiles").select("id, display_name, first_name, last_name"),
  ]);

  const names = new Map(
    ((profiles ?? []) as Array<{
      id: string;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
    }>).map((p) => [
      p.id,
      p.display_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Ojo player",
    ]),
  );

  return ((rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    resolvedAt: (r.resolved_at as string) ?? null,
    reason: String(r.reason),
    targetKind: String(r.target_kind),
    targetId: String(r.target_id),
    contentSnapshot: (r.content_snapshot as string) ?? null,
    details: (r.details as string) ?? null,
    reporterName: names.get(String(r.reporter_id)) ?? "—",
    reportedName: r.reported_user_id
      ? names.get(String(r.reported_user_id)) ?? "Deleted account"
      : "Deleted account",
    reportedUserId: (r.reported_user_id as string) ?? null,
  }));
}

/**
 * Mark a report actioned. Idempotent: re-resolving keeps the original
 * timestamp, so a double-click cannot rewrite when the decision was made.
 */
export async function resolveReport(id: string, resolved: boolean): Promise<void> {
  const db = getSupabaseServiceRole();
  const patch = resolved ? { resolved_at: new Date().toISOString() } : { resolved_at: null };
  let q = db.from("content_reports").update(patch).eq("id", id);
  if (resolved) q = q.is("resolved_at", null);
  const { error } = await q;
  if (error) throw new Error(`resolve report failed: ${error.message}`);
}

export interface EventRollup {
  name: string;
  total: number;
  last7: number;
  web: number;
  ios: number;
}

export async function eventRollup(): Promise<{
  rollup: EventRollup[];
  daily: Array<{ day: string; n: number }>;
  optOuts: number;
}> {
  const db = getSupabaseServiceRole();
  const { data } = await db
    .from("events")
    .select("name, platform, occurred_at")
    .order("occurred_at", { ascending: false })
    .limit(20000);

  const rows = (data ?? []) as Array<{ name: string; platform: string; occurred_at: string }>;
  const weekAgo = Date.now() - 7 * 864e5;

  const byName = new Map<string, EventRollup>();
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const e = byName.get(r.name) ?? { name: r.name, total: 0, last7: 0, web: 0, ios: 0 };
    e.total += 1;
    if (new Date(r.occurred_at).getTime() >= weekAgo) e.last7 += 1;
    if (r.platform === "ios") e.ios += 1;
    else e.web += 1;
    byName.set(r.name, e);

    const day = r.occurred_at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  return {
    rollup: [...byName.values()].sort((a, b) => b.total - a.total),
    daily: [...byDay.entries()]
      .map(([day, n]) => ({ day, n }))
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-30),
    optOuts: 0,
  };
}

/** The five views from 0019. Each is a small table; render whatever comes back. */
export async function metricsViews(): Promise<Record<string, Array<Record<string, unknown>>>> {
  const db = getSupabaseServiceRole();
  const names = [
    "metrics_share_rate",
    "metrics_share_conversion",
    "metrics_second_watch",
    "metrics_recording_retention",
    "metrics_upload_reliability",
  ];
  const out: Record<string, Array<Record<string, unknown>>> = {};
  await Promise.all(
    names.map(async (n) => {
      const { data, error } = await db.from(n).select("*").limit(12);
      out[n] = error ? [] : ((data ?? []) as Array<Record<string, unknown>>);
    }),
  );
  return out;
}
