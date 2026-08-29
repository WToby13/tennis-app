import { getSupabaseServiceRole } from "../supabase/service";

/**
 * What the service costs to run, from what the database can actually prove.
 *
 * The honest shape of this problem: **usage is measurable, price is not.** We
 * know exactly how many gigabytes are stored and how many minutes have been
 * analysed, because those are rows. We do not know what AWS charged for them —
 * rates differ by region, tier and commitment, and egress in particular depends
 * on traffic nobody here records. So this multiplies measured usage by rates you
 * set, and labels the result an estimate rather than a bill.
 *
 * Egress is deliberately left blank rather than guessed. A plausible-looking
 * number invented from playback counts would be the most quoted figure on this
 * page and the least true one — CloudFront bills bytes actually transferred, and
 * a viewer who scrubs to three rallies of a 3 GB match transfers almost none of
 * it. The AWS console is the only honest source, so the page says so.
 */

/** Rates, all overridable. Defaults are eu-west-1 list prices at time of writing. */
function rates() {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    s3PerGbMonth: num(process.env.COST_S3_PER_GB_MONTH, 0.023),
    analysisPerMinute: num(process.env.COST_ANALYSIS_PER_MINUTE, 0.033),
    fixedMonthly: num(process.env.COST_FIXED_MONTHLY, 0),
    currency: process.env.COST_CURRENCY?.trim() || "USD",
  };
}

export interface Costs {
  storageGb: number;
  proxyCount: number;
  analysedMinutes: number;
  analysedMatches: number;
  storageMonthly: number;
  analysisTotal: number;
  analysisThisMonth: number;
  fixedMonthly: number;
  estimatedMonthly: number;
  currency: string;
  rates: ReturnType<typeof rates>;
  biggest: Array<{ id: string; title: string; gb: number; minutes: number | null }>;
}

export async function costs(): Promise<Costs> {
  const db = getSupabaseServiceRole();
  const r = rates();

  const { data } = await db
    .from("videos")
    .select("id, title, size_bytes, duration_s, analysis_status, analyzed_at, has_analysis_proxy")
    .is("deleted_at", null);

  const rows = (data ?? []) as Array<{
    id: string;
    title: string | null;
    size_bytes: number | null;
    duration_s: number | null;
    analysis_status: string | null;
    analyzed_at: string | null;
    has_analysis_proxy: boolean | null;
  }>;

  const GB = 1024 ** 3;
  const storageGb = rows.reduce((s, v) => s + Number(v.size_bytes ?? 0), 0) / GB;
  const proxyCount = rows.filter((v) => v.has_analysis_proxy).length;

  const analysed = rows.filter((v) => v.analysis_status === "ready");
  const analysedMinutes = analysed.reduce((s, v) => s + Number(v.duration_s ?? 0), 0) / 60;

  // Analysis is billed once, when it runs — so "this month" is the only part of
  // it that recurs, and the rest is sunk. Splitting them stops a one-off backlog
  // of analyses looking like a monthly cost forever.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const analysedThisMonth = analysed.filter(
    (v) => v.analyzed_at && new Date(v.analyzed_at) >= monthStart,
  );
  const minutesThisMonth =
    analysedThisMonth.reduce((s, v) => s + Number(v.duration_s ?? 0), 0) / 60;

  const storageMonthly = storageGb * r.s3PerGbMonth;
  const analysisTotal = analysedMinutes * r.analysisPerMinute;
  const analysisThisMonth = minutesThisMonth * r.analysisPerMinute;

  const biggest = rows
    .map((v) => ({
      id: v.id,
      title: v.title ?? "Untitled match",
      gb: Number(v.size_bytes ?? 0) / GB,
      minutes: v.duration_s == null ? null : Number(v.duration_s) / 60,
    }))
    .sort((a, b) => b.gb - a.gb)
    .slice(0, 10);

  return {
    storageGb,
    proxyCount,
    analysedMinutes,
    analysedMatches: analysed.length,
    storageMonthly,
    analysisTotal,
    analysisThisMonth,
    fixedMonthly: r.fixedMonthly,
    estimatedMonthly: storageMonthly + analysisThisMonth + r.fixedMonthly,
    currency: r.currency,
    rates: r,
    biggest,
  };
}
