# Ojo — Admin dashboard

`/admin`, for one operator. Written 2026-08-29.

---

## 1. Who can see it

`ADMIN_EMAIL`, compared case-insensitively against the address on the Supabase
session — read server-side, never from the client, and never from `profiles`
(whose `display_name` a user can edit).

**Unset means nobody, not everybody.** A fresh environment — a preview deploy, a
fork, a new machine — has no dashboard at all until the variable is set
deliberately. That is the safe reading of a missing variable, and it is the one
[`lib/admin/guard.ts`](../web/lib/admin/guard.ts) implements.

An email in an environment variable rather than a `profiles.is_admin` column,
because a column is a row that anyone with a database connection can flip, while
an env var can only be changed by whoever controls the deployment.

**Unauthorised requests get 404, not 403.** A 403 confirms the route exists and
that someone is behind it. Nothing here is worth confirming to a stranger.

**Every route re-checks for itself.** The layout gate hides the UI; a hidden page
is not a protected one. `POST /api/admin/reports/[id]` calls `currentAdmin()`
independently, so a hand-crafted request is refused on its own merits rather
than because a page declined to render a button.

Verified 2026-08-29 against a live session, all three cases:

| Case | Result |
|---|---|
| Signed out | middleware redirects to `/sign-in` (pages), 401 (API) |
| Signed in, **not** the admin | **404** on every page **and** on the API |
| `ADMIN_EMAIL` unset, signed in as the usual admin | **404** — fail closed |

## 2. Why it uses the service role

Every other path in this app is RLS-scoped to the caller, deliberately. "How
many people signed up this week" is exactly the question RLS exists to refuse,
so [`lib/admin/queries.ts`](../web/lib/admin/queries.ts) uses the service-role
key. The guard is what makes that safe: the key is only reached after the
session email has matched.

Without `SUPABASE_SERVICE_ROLE_KEY` the pages render a banner saying so rather
than showing zeroes, because a dashboard that reports "0 members" when it simply
cannot read the table is worse than one that admits it is broken.

## 3. The pages

| Page | Answers |
|---|---|
| **Overview** | Is anything wrong right now? Red tiles are the point; growth numbers are context. Anything alarming links to the page that can act on it. |
| **Members** | Everyone, newest first, with matches, storage and last-seen. Click through for their matches and last 50 events. |
| **Matches** | Both pipelines — upload and analysis — with failures pulled to the top and the runner's own error text. |
| **Events** | Per-event counts, a 30-day bar, and the five metric views from `0019`. |
| **Reports** | The moderation queue. Open first, oldest at the top. |
| **Costs** | Measured usage × configurable rates. |

The metric views are rendered **generically** — whatever columns the SQL returns
become the columns here. The definitions stay in `0019_events.sql`, so this page
cannot become a second place where a metric is defined slightly differently.

## 4. Reports

Resolving does not delete anything. A report is the record of a decision, and
"looked at it, nothing to do" is a legitimate outcome that should still leave a
trace — which is also why **Reopen** exists.

Resolving is idempotent: the update only touches rows where `resolved_at is
null`, so a double-click cannot rewrite when the decision was made.

Removing content is still a SQL job, and deliberately so — it is rare, it is
destructive, and a button for it on a page reachable in two clicks is a worse
trade than a query someone has to mean:

```sql
update public.videos set deleted_at = now() where id = '<video id>';
delete from public.match_comments where id = '<comment id>';
```

## 5. Costs, and what is not there

Usage is measured; prices are assumed. Gigabytes and minutes are rows in the
database. What AWS charged for them is not, so the page multiplies measured
usage by rates from the environment and calls the result an estimate.

**Egress is deliberately blank.** CloudFront bills bytes actually transferred,
and nothing here records that. A viewer who scrubs to three rallies of a 3 GB
match transfers a fraction of it, so a figure derived from playback counts would
be invented — and it would be the most-quoted number on the page. On a video
product it is usually the largest AWS line, so the page says to check the AWS
console instead of guessing.

Rates: `COST_S3_PER_GB_MONTH`, `COST_ANALYSIS_PER_MINUTE`, `COST_FIXED_MONTHLY`,
`COST_CURRENCY`. Defaults are eu-west-1 list prices.

## 6. Setup

```
ADMIN_EMAIL=tobykeating13@gmail.com
```

in Vercel, then redeploy. `SUPABASE_SERVICE_ROLE_KEY` must already be set — it is,
for analytics and the cron sweep.

Nothing else. No migration: the five metric views were revoked from `anon` and
`authenticated` in `0019` but never from `service_role`, which is what reads them
here — confirmed by running the whole chain and selecting each view as
`service_role`.
