-- Delete analytics events older than twelve months, weekly.
--
-- Separate from 0019 for the same reason 0012 is separate: this needs pg_cron,
-- which a plain local Postgres doesn't have, so supabase/tests/run.sh skips it
-- and runs everything else. The function it calls (public.delete_old_events)
-- lives in 0019 and *is* covered by the tests.
--
-- /privacy states a twelve-month retention window for usage data. Without this
-- job that sentence is a wish rather than a fact, so it is not optional.

create extension if not exists pg_cron;

-- Idempotent: re-running replaces the schedule rather than stacking a copy.
select cron.unschedule('ojo-prune-events')
where exists (select 1 from cron.job where jobname = 'ojo-prune-events');

-- 04:20 on Sundays: off the back of the nightly Vercel cron and well clear of
-- the 5-minute analysis sweep.
select cron.schedule(
  'ojo-prune-events',
  '20 4 * * 0',
  $job$ select public.delete_old_events(); $job$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Checking it works
--
--   select jobid, runid, status, return_message, start_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'ojo-prune-events')
--   order by start_time desc limit 5;
--
-- To run it by hand once:   select public.delete_old_events();
-- To pause without dropping: update cron.job set active = false
--                            where jobname = 'ojo-prune-events';
-- ─────────────────────────────────────────────────────────────────────────────
