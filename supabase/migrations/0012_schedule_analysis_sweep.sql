-- Drive the analysis sweep every 5 minutes from Postgres.
--
-- Why not Vercel cron: the Hobby plan allows one run per day, and a more
-- frequent expression fails the deployment (see web/vercel.json, which keeps a
-- daily run as a backstop). pg_cron has no such limit, so this is what actually
-- makes a run independent of anyone having a page open.
--
-- The endpoint is idempotent and authenticates with CRON_SECRET, so it's safe to
-- call from here, from Vercel's daily cron, and from a user's open tab, all at
-- once.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- BEFORE running this, store the secret. Run this line ON ITS OWN, with your
-- real CRON_SECRET substituted — do NOT commit it:
--
--   select vault.create_secret('<paste CRON_SECRET here>', 'ojo_cron_secret',
--                              'Bearer token for /api/cron/advance-analyses');
--
-- It must match the CRON_SECRET set in the Vercel project. To rotate later:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'ojo_cron_secret'),
--     '<new secret>');
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: re-running this migration replaces the schedule rather than
-- stacking a second copy of the job.
select cron.unschedule('ojo-advance-analyses')
where exists (select 1 from cron.job where jobname = 'ojo-advance-analyses');

select cron.schedule(
  'ojo-advance-analyses',
  '*/5 * * * *',
  $job$
  select net.http_get(
    url := 'https://ojotennis.com/api/cron/advance-analyses',
    headers := jsonb_build_object(
      'Authorization',
      'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'ojo_cron_secret'
      )
    ),
    -- The endpoint self-limits to ~45s, so this only trips if it hangs.
    timeout_milliseconds := 55000
  );
  $job$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Checking it works
--
-- Did the job fire?
--   select jobid, runid, status, return_message, start_time
--   from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'ojo-advance-analyses')
--   order by start_time desc limit 10;
--
-- What did the endpoint reply? (200 = swept, 401 = secret mismatch,
-- 503 = CRON_SECRET not set in Vercel)
--   select id, status_code, content, created
--   from net._http_response order by created desc limit 10;
--
-- To pause without dropping it:
--   update cron.job set active = false where jobname = 'ojo-advance-analyses';
--
-- Note pg_net keeps responses in net._http_response for a few hours and prunes
-- them itself; at one row per 5 minutes this stays small.
-- ─────────────────────────────────────────────────────────────────────────────
