-- Product analytics: one append-only events table, and the four numbers
-- docs/GTM.md §6 says are the only ones that matter at this stage.
-- Run in the Supabase SQL editor after 0018_analysis_window_attempts.sql.
--
-- Why this lives in Postgres rather than in PostHog/Amplitude/Mixpanel:
--
--   1. Every question we actually want to ask is a *join* against rows we
--      already own. "Share rate = matches shared ÷ matches uploaded" and
--      "second-watch = watched again a day later" are SQL over `videos`,
--      `share_links` and this table. Sending all that context to a third party
--      so we can re-join it there, in their query language, is strictly worse.
--   2. It keeps the App Store privacy label honest. No third-party SDK, no
--      advertising identifier, nothing leaving our own processors — so
--      "used for tracking: No" stays true and no ATT prompt is needed.
--      See docs/APPSTORE.md §8.
--   3. At this volume it is free. A few thousand rows a month is nothing.
--
-- Revisit if we ever want session replay, or pass ~1M events/month.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),

  -- Stamped server-side from the session the middleware already verified, never
  -- from the request body. Null for someone with no account yet — which is not
  -- an edge case here but the single most important row in the funnel: the
  -- person who just opened a share link.
  user_id     uuid references auth.users (id) on delete cascade,

  -- Anonymous, per-tab-session id minted by the client. Lets us stitch "opened
  -- a share link" to "signed up" without storing anything that survives the
  -- browser session. See web/lib/analytics/client.ts for why it is deliberately
  -- sessionStorage and not a cookie.
  anon_id     text,
  session_id  text,

  name        text not null check (length(name) between 1 and 64),
  platform    text not null check (platform in ('web', 'ios')),
  app_version text check (length(app_version) <= 32),

  -- The match an event is about, when it is about one. `set null` rather than
  -- cascade: deleting a match should not silently rewrite last month's upload
  -- numbers.
  video_id    uuid references public.videos (id) on delete set null,

  -- Small, event-specific extras. Capped here as well as in the API route,
  -- because the route is a public endpoint and this is the backstop.
  props       jsonb not null default '{}'::jsonb
                check (pg_column_size(props) <= 4096)
);

-- `on delete cascade` on user_id is the deliberate reading of what /privacy
-- promises: delete your account and your data goes. The cost is that aggregate
-- history shifts retroactively when someone leaves. At this scale that is the
-- right trade — the alternative is keeping behavioural rows about a person who
-- asked us to forget them, which is not a defensible thing to do for the sake
-- of a tidier chart.

-- Every view below filters on name first, then time.
create index if not exists events_name_time_idx on public.events (name, occurred_at desc);
-- The retention sweep deletes by age alone.
create index if not exists events_time_idx on public.events (occurred_at);
create index if not exists events_user_idx on public.events (user_id, occurred_at desc)
  where user_id is not null;
create index if not exists events_anon_idx on public.events (anon_id)
  where anon_id is not null;
create index if not exists events_video_idx on public.events (video_id)
  where video_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Nobody reads this but us
-- ---------------------------------------------------------------------------
-- RLS on with *no policies at all*: under RLS a table with no matching policy
-- denies everything, so `authenticated` cannot read or write a single row. The
-- revoke is belt-and-braces against Supabase's default grant to the API roles
-- (the same reason 0015 had to use column grants to hide invite_token).
--
-- Writes come from the service role in /api/events, which bypasses RLS. That is
-- the only path in.
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;

-- The identity sequence is granted alongside the table by Supabase's defaults.
revoke all on all sequences in schema public from anon;

-- ---------------------------------------------------------------------------
-- 3. Retention
-- ---------------------------------------------------------------------------
-- Raw events past a year are of no use to a product this age and are a
-- liability to hold. /privacy commits to twelve months; this is what makes that
-- true rather than aspirational. Scheduled by 0020 (kept separate so the
-- offline test runner, which has no pg_cron, can still run everything here).
create or replace function public.delete_old_events()
returns integer language plpgsql security definer set search_path = public as $$
declare
  removed integer;
begin
  delete from public.events where occurred_at < now() - interval '12 months';
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.delete_old_events() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The four numbers from GTM §6
-- ---------------------------------------------------------------------------
-- All five views are `security_invoker` and granted to nobody: they are read in
-- the Supabase SQL editor (which connects as the owner), not by the app. If one
-- is ever put behind an admin page, grant it explicitly there and think about
-- it then.
--
-- Note every view derives its denominator from events too, not from `videos`.
-- That is on purpose: it keeps numerator and denominator over exactly the
-- instrumented window, so the ratios aren't dragged down by matches that
-- predate analytics existing.

-- 4.1 Share rate — matches shared ÷ matches uploaded.
--     The loop's input. If people record and don't share, there is no growth
--     mechanic, only an app.
--
--     Cohorted by *upload* week: of the matches uploaded that week, how many
--     were ever shared, whenever that happened. A match shared three ways is
--     one shared match.
create or replace view public.metrics_share_rate with (security_invoker = on) as
with uploaded as (
  select video_id, date_trunc('week', min(occurred_at))::date as week
  from public.events
  where name = 'upload_completed' and video_id is not null
  group by video_id
),
shared as (
  select distinct video_id
  from public.events
  where name = 'match_shared' and video_id is not null
)
select
  u.week,
  count(*)                                              as matches_uploaded,
  count(*) filter (where s.video_id is not null)        as matches_shared,
  round(count(*) filter (where s.video_id is not null)::numeric
        / nullif(count(*), 0), 3)                       as share_rate
from uploaded u
left join shared s on s.video_id = u.video_id
group by u.week
order by u.week desc;

-- 4.2 Share conversion — recipients who create an account ÷ links opened.
--     The loop's multiplier, and the number GTM blocker #2 is thought to be
--     capping.
--
--     `hit_sign_in_wall` is here so the cost of that blocker is measurable
--     *before* it is fixed: today a shared /watch link bounces a signed-out
--     recipient to /sign-in, and this column says how many people that happens
--     to and how many of them never come back.
--
--     Only counts opens by someone with no session — the owner re-watching
--     their own link is not a conversion opportunity.
create or replace view public.metrics_share_conversion with (security_invoker = on) as
with
-- Identity stitching. The browser client keeps sending its anon_id after
-- sign-in, and the server stamps user_id on those same rows, so any event
-- carrying both is a statement that this anonymous visitor became this account.
-- That bridge is what lets a server-side event like `library_add` — which knows
-- the account but has never heard of an anon_id — be credited back to the share
-- link that started it.
identity as (
  select distinct anon_id, user_id
  from public.events
  where anon_id is not null and user_id is not null
),
opened as (
  select anon_id, min(occurred_at) as first_open
  from public.events
  where name = 'share_link_opened' and anon_id is not null and user_id is null
  group by anon_id
),
walled as (
  select distinct anon_id from public.events
  where name = 'sign_in_wall_hit' and anon_id is not null
),
signed_up as (
  -- Password sign-ups report themselves from the form and carry the anon_id
  -- directly; Google/magic-link ones are recorded server-side in the auth
  -- callback, which has an account but has never seen an anon_id — so those are
  -- credited back through the bridge.
  select distinct anon_id from public.events
  where name = 'signup_completed' and anon_id is not null
  union
  select distinct i.anon_id
  from public.events e
  join identity i on i.user_id = e.user_id
  where e.name = 'signup_completed' and e.user_id is not null
),
added as (
  select distinct i.anon_id
  from public.events e
  join identity i on i.user_id = e.user_id
  where e.name = 'library_add' and e.user_id is not null
)
select
  date_trunc('week', o.first_open)::date            as week,
  count(*)                                          as links_opened,
  count(*) filter (where w.anon_id is not null)     as hit_sign_in_wall,
  count(*) filter (where s.anon_id is not null)     as signed_up,
  count(*) filter (where a.anon_id is not null)     as added_to_library,
  round(count(*) filter (where s.anon_id is not null)::numeric
        / nullif(count(*), 0), 3)                   as conversion
from opened o
left join walled    w on w.anon_id = o.anon_id
left join signed_up s on s.anon_id = o.anon_id
left join added     a on a.anon_id = o.anon_id
group by 1
order by 1 desc;

-- 4.3 Second-watch rate — matches watched again on a later day.
--     The honest retention signal: watched once was a novelty, watched twice it
--     was useful. Counted per (viewer, match) pair on distinct calendar days,
--     so scrubbing back and forth in one sitting doesn't count as two.
create or replace view public.metrics_second_watch with (security_invoker = on) as
with watch_days as (
  select
    video_id,
    coalesce(user_id::text, anon_id) as viewer,
    occurred_at::date                as day
  from public.events
  where name = 'watch_started'
    and video_id is not null
    and coalesce(user_id::text, anon_id) is not null
  group by 1, 2, 3
),
per_pair as (
  select video_id, viewer, count(*) as distinct_days, min(day) as first_day
  from watch_days
  group by 1, 2
)
select
  date_trunc('week', first_day)::date              as week,
  count(*)                                         as matches_watched,
  count(*) filter (where distinct_days >= 2)       as watched_again_later,
  round(count(*) filter (where distinct_days >= 2)::numeric
        / nullif(count(*), 0), 3)                  as second_watch_rate
from per_pair
group by 1
order by 1 desc;

-- 4.4 Recording retention — did it become a habit or a toy.
--     Weekly cohorts by first completed upload, then whether that person
--     completed another upload in each following week.
create or replace view public.metrics_recording_retention with (security_invoker = on) as
with first_upload as (
  select user_id, date_trunc('week', min(occurred_at))::date as cohort_week
  from public.events
  where name = 'upload_completed' and user_id is not null
  group by user_id
),
activity as (
  select distinct user_id, date_trunc('week', occurred_at)::date as week
  from public.events
  where name = 'upload_completed' and user_id is not null
)
select
  f.cohort_week,
  count(distinct f.user_id)                                                   as cohort_size,
  count(distinct a.user_id) filter (where a.week = f.cohort_week + 7)         as week_1,
  count(distinct a.user_id) filter (where a.week = f.cohort_week + 14)        as week_2,
  count(distinct a.user_id) filter (where a.week = f.cohort_week + 21)        as week_3,
  count(distinct a.user_id) filter (where a.week = f.cohort_week + 28)        as week_4,
  round(count(distinct a.user_id) filter (where a.week = f.cohort_week + 28)::numeric
        / nullif(count(distinct f.user_id), 0), 3)                            as week_4_retention
from first_upload f
left join activity a on a.user_id = f.user_id
group by f.cohort_week
order by f.cohort_week desc;

-- 4.5 Upload reliability — not a GTM number, but the one thing most likely to
--     sink a first release. OPERATIONS.md §1 explains at length why a long
--     upload used to fail; this is where we find out whether it still does, on
--     real phones and real club Wi-Fi, rather than by waiting for someone to
--     mention it.
create or replace view public.metrics_upload_reliability with (security_invoker = on) as
with attempts as (
  select
    date_trunc('week', occurred_at)::date as week,
    platform,
    name,
    video_id,
    (props ->> 'sizeBytes')::bigint       as size_bytes,
    (props ->> 'partRetries')::int        as part_retries
  from public.events
  where name in ('upload_started', 'upload_completed', 'upload_failed')
)
select
  week,
  platform,
  count(*) filter (where name = 'upload_started')    as started,
  count(*) filter (where name = 'upload_completed')  as completed,
  count(*) filter (where name = 'upload_failed')     as failed,
  round(count(*) filter (where name = 'upload_completed')::numeric
        / nullif(count(*) filter (where name = 'upload_started'), 0), 3) as completion_rate,
  round(avg(size_bytes) filter (where name = 'upload_completed') / 1e9, 2) as avg_gb,
  sum(part_retries) filter (where name = 'upload_completed')               as part_retries
from attempts
group by week, platform
order by week desc, platform;

revoke all on public.metrics_share_rate,
              public.metrics_share_conversion,
              public.metrics_second_watch,
              public.metrics_recording_retention,
              public.metrics_upload_reliability
  from anon, authenticated;
