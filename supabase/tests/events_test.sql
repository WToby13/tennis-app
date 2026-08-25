\set ON_ERROR_STOP on
\pset pager off

-- Assertions for 0019_events.sql.
--
-- Two things are being proved here, and they are of quite different kinds.
--
-- The first is a privacy claim. `/privacy` and the App Store label both say the
-- usage record is ours alone, that no third party sees it, and that deleting an
-- account deletes it. The table is protected by RLS with *no policies* plus a
-- revoke — an unusual combination, and one where getting it wrong fails open
-- and silently, since Supabase grants every new public table to the API roles by
-- default. So it is asserted rather than assumed.
--
-- The second is that the four numbers in docs/GTM.md §6 are computed correctly.
-- They are the numbers a launch decision gets made on; a share rate that is
-- quietly wrong is worse than no share rate at all.

create or replace function assert(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok: %', what;
end $$;

-- ---------------------------------------------------------------------------
-- Cast: Ana records and shares. Ben is the person she played, and arrives via
-- her link. Cal opens a link and never signs up.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaa0000-0000-0000-0000-00000000000a', 'ana@example.com', '{"first_name":"Ana"}'),
  ('bbbb0000-0000-0000-0000-00000000000b', 'ben@example.com', '{"first_name":"Ben"}');

insert into public.videos (id, owner_id, title, key, content_type, size_bytes, part_size_bytes, status, visibility)
values ('aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'Ana vs Ben', 'videos/ana.mov', 'video/quicktime', 1, 1, 'ready', 'private'),
       ('aaaa1111-0000-0000-0000-000000000002',
        'aaaa0000-0000-0000-0000-00000000000a',
        'Ana solo', 'videos/ana2.mov', 'video/quicktime', 1, 1, 'ready', 'private');

-- ===========================================================================
-- 1. Nobody but the server can touch the table
-- ===========================================================================
select assert(relrowsecurity, 'RLS is enabled on events')
  from pg_class where oid = 'public.events'::regclass;

-- The combination that makes the deny total: RLS on, and no policy to satisfy.
select assert(count(*) = 0, 'events has no RLS policies, so RLS denies everything')
  from pg_policies where schemaname = 'public' and tablename = 'events';

-- And the grant is gone, which is the half that is easy to forget: Supabase's
-- default privileges hand every new public table to anon and authenticated, so
-- without the revoke in 0019 the table would be readable the moment RLS were
-- ever disabled for a migration.
select assert(count(*) = 0, 'no table privileges remain for anon or authenticated')
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'events'
   and grantee in ('anon', 'authenticated');

select assert(count(*) = 0, 'the metric views are not granted to anon or authenticated')
  from information_schema.role_table_grants
 where table_schema = 'public'
   and table_name like 'metrics_%'
   and grantee in ('anon', 'authenticated');

-- The retention function must not be callable by a client either — it deletes.
select assert(not has_function_privilege('authenticated', 'public.delete_old_events()', 'execute'),
              'authenticated cannot execute delete_old_events');

-- ===========================================================================
-- 2. Guards on what can be written
-- ===========================================================================
do $$ begin
  begin
    insert into public.events (name, platform) values ('x', 'android');
    raise exception 'FAIL: an unknown platform was accepted';
  exception when check_violation then null;
  end;
end $$;
select assert(true, 'platform is constrained to web and ios');

do $$ begin
  begin
    -- Well past the 4 KB cap, so a public endpoint cannot be used as free storage.
    insert into public.events (name, platform, props)
    values ('watch_started', 'web', jsonb_build_object('blob', repeat('x', 8000)));
    raise exception 'FAIL: an oversized props payload was accepted';
  exception when check_violation then null;
  end;
end $$;
select assert(true, 'props is capped at 4 KB');

-- ===========================================================================
-- 3. Account deletion takes the usage record with it
--
-- This is the promise in /privacy ("deleting your account deletes ... the record
-- of how you used the app") and in docs/APPSTORE.md §8.1. It rests entirely on
-- ON DELETE CASCADE, which is one word in a column definition and would fail
-- silently if it were ever changed to SET NULL — as video_participants.user_id
-- deliberately is, so the two are easy to confuse.
-- ===========================================================================
insert into public.events (user_id, name, platform)
values ('bbbb0000-0000-0000-0000-00000000000b', 'sign_in', 'ios');

select assert(count(*) = 1, 'Ben has a usage record') from public.events
 where user_id = 'bbbb0000-0000-0000-0000-00000000000b';

delete from auth.users where id = 'bbbb0000-0000-0000-0000-00000000000b';

select assert(count(*) = 0, 'deleting Ben''s account deleted his usage record')
  from public.events where user_id = 'bbbb0000-0000-0000-0000-00000000000b';

-- Deleting a *match*, by contrast, must not erase the fact that it was uploaded:
-- last month's numbers should not move because someone tidied their library.
insert into public.events (user_id, name, platform, video_id)
values ('aaaa0000-0000-0000-0000-00000000000a', 'upload_completed', 'ios',
        'aaaa1111-0000-0000-0000-000000000002');
delete from public.videos where id = 'aaaa1111-0000-0000-0000-000000000002';
select assert(count(*) = 1, 'deleting a match keeps its events, with video_id nulled')
  from public.events
 where name = 'upload_completed' and user_id = 'aaaa0000-0000-0000-0000-00000000000a'
   and video_id is null;

truncate public.events;
delete from auth.users where id = 'aaaa0000-0000-0000-0000-00000000000a';

-- ===========================================================================
-- 4. The four numbers
-- ===========================================================================
insert into auth.users (id, email) values
  ('aaaa0000-0000-0000-0000-00000000000a', 'ana@example.com'),
  ('bbbb0000-0000-0000-0000-00000000000b', 'ben@example.com');
insert into public.videos (id, owner_id, title, key, content_type, size_bytes, part_size_bytes, status, visibility)
values ('aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'Ana vs Ben', 'videos/ana.mov', 'video/quicktime', 1, 1, 'ready', 'private'),
       ('aaaa1111-0000-0000-0000-000000000003',
        'aaaa0000-0000-0000-0000-00000000000a',
        'Ana vs the wall', 'videos/ana3.mov', 'video/quicktime', 1, 1, 'ready', 'private');

-- Fixed clock, so week boundaries are deterministic. 2026-06-01 is a Monday,
-- which is where date_trunc('week') starts.
\set w0 '2026-06-01 10:00:00+00'

-- 4.1 Share rate: Ana uploads two matches and shares one of them (twice, by two
--     different routes — still one shared match).
insert into public.events (occurred_at, user_id, name, platform, video_id, props) values
  (:'w0'::timestamptz, 'aaaa0000-0000-0000-0000-00000000000a', 'upload_started',   'ios', 'aaaa1111-0000-0000-0000-000000000001', '{"sizeBytes": 4000000000}'),
  (:'w0'::timestamptz, 'aaaa0000-0000-0000-0000-00000000000a', 'upload_completed', 'ios', 'aaaa1111-0000-0000-0000-000000000001', '{"sizeBytes": 4000000000, "partRetries": 3}'),
  (:'w0'::timestamptz, 'aaaa0000-0000-0000-0000-00000000000a', 'upload_started',   'ios', 'aaaa1111-0000-0000-0000-000000000003', '{"sizeBytes": 1000000000}'),
  (:'w0'::timestamptz, 'aaaa0000-0000-0000-0000-00000000000a', 'upload_completed', 'ios', 'aaaa1111-0000-0000-0000-000000000003', '{"sizeBytes": 1000000000, "partRetries": 0}'),
  (:'w0'::timestamptz, 'aaaa0000-0000-0000-0000-00000000000a', 'match_shared',     'web', 'aaaa1111-0000-0000-0000-000000000001', '{"channel": "link"}'),
  (:'w0'::timestamptz, 'aaaa0000-0000-0000-0000-00000000000a', 'match_shared',     'web', 'aaaa1111-0000-0000-0000-000000000001', '{"channel": "invite"}');

select assert(matches_uploaded = 2 and matches_shared = 1 and share_rate = 0.500,
              'share rate counts a match shared twice as one shared match')
  from public.metrics_share_rate;

-- An upload that never completed is not in the denominator: share rate is about
-- matches that exist, and upload reliability is a separate number.
select assert(started = 2 and completed = 2 and failed = 0 and completion_rate = 1.000
              and part_retries = 3,
              'upload reliability totals retries across completed uploads')
  from public.metrics_upload_reliability where platform = 'ios';

-- 4.2 Share conversion. Ben opens Ana's link with no account, hits the sign-in
--     wall, signs up, and adds the match. Cal opens a link and disappears.
--     Ben's `library_add` is written server-side and so carries an account but
--     no anon_id — the identity bridge is what has to connect the two.
insert into public.events (occurred_at, user_id, anon_id, name, platform, video_id, props) values
  (:'w0'::timestamptz + interval '1 hour', null, 'anon-ben', 'share_link_opened', 'web', 'aaaa1111-0000-0000-0000-000000000001', '{"via": "share_token"}'),
  (:'w0'::timestamptz + interval '1 hour', null, 'anon-ben', 'sign_in_wall_hit',  'web', 'aaaa1111-0000-0000-0000-000000000001', '{}'),
  (:'w0'::timestamptz + interval '2 hour', null, 'anon-cal', 'share_link_opened', 'web', 'aaaa1111-0000-0000-0000-000000000001', '{"via": "share_token"}'),
  (:'w0'::timestamptz + interval '2 hour', null, 'anon-cal', 'sign_in_wall_hit',  'web', 'aaaa1111-0000-0000-0000-000000000001', '{}');

-- Ben signs up. The signup event still carries his anon_id (same tab), and every
-- event after it carries both — which is what builds the bridge.
insert into public.events (occurred_at, user_id, anon_id, name, platform, video_id, props) values
  (:'w0'::timestamptz + interval '3 hour', null, 'anon-ben', 'signup_completed', 'web', null, '{"method": "password"}'),
  (:'w0'::timestamptz + interval '4 hour', 'bbbb0000-0000-0000-0000-00000000000b', 'anon-ben', 'watch_started', 'web', 'aaaa1111-0000-0000-0000-000000000001', '{}');
-- ...and the add itself, from the server, with no anon_id at all.
insert into public.events (occurred_at, user_id, name, platform, video_id, props) values
  (:'w0'::timestamptz + interval '4 hour', 'bbbb0000-0000-0000-0000-00000000000b', 'library_add', 'web', 'aaaa1111-0000-0000-0000-000000000001', '{"via": "share_token"}');

select assert(links_opened = 2 and hit_sign_in_wall = 2 and signed_up = 1
              and added_to_library = 1 and conversion = 0.500,
              'share conversion credits a server-side library_add back through the identity bridge')
  from public.metrics_share_conversion;

-- 4.3 Second watch. Ana watches her own match on two separate days; Ben watches
--     once. Scrubbing back and forth on one day is still one watch.
insert into public.events (occurred_at, user_id, name, platform, video_id) values
  (:'w0'::timestamptz + interval '5 hour', 'aaaa0000-0000-0000-0000-00000000000a', 'watch_started', 'web', 'aaaa1111-0000-0000-0000-000000000001'),
  (:'w0'::timestamptz + interval '6 hour', 'aaaa0000-0000-0000-0000-00000000000a', 'watch_started', 'web', 'aaaa1111-0000-0000-0000-000000000001'),
  (:'w0'::timestamptz + interval '2 day',  'aaaa0000-0000-0000-0000-00000000000a', 'watch_started', 'web', 'aaaa1111-0000-0000-0000-000000000001');

select assert(matches_watched = 2 and watched_again_later = 1 and second_watch_rate = 0.500,
              'second-watch counts distinct days, not distinct plays')
  from public.metrics_second_watch;

-- 4.4 Recording retention. Ana uploads in her first week and again four weeks
--     later; Ben uploads once and never comes back.
insert into public.events (occurred_at, user_id, name, platform, video_id) values
  (:'w0'::timestamptz, 'bbbb0000-0000-0000-0000-00000000000b', 'upload_completed', 'ios', 'aaaa1111-0000-0000-0000-000000000001'),
  (:'w0'::timestamptz + interval '28 days', 'aaaa0000-0000-0000-0000-00000000000a', 'upload_completed', 'ios', 'aaaa1111-0000-0000-0000-000000000001');

select assert(cohort_size = 2 and week_4 = 1 and week_4_retention = 0.500,
              'week-4 retention counts a second upload four weeks on')
  from public.metrics_recording_retention;

-- ===========================================================================
-- 5. Retention sweep
-- ===========================================================================
insert into public.events (occurred_at, user_id, name, platform)
values (now() - interval '13 months', 'aaaa0000-0000-0000-0000-00000000000a', 'sign_in', 'web');

select assert(public.delete_old_events() = 1, 'the sweep deletes exactly the row past twelve months');
select assert(count(*) = 0, 'and nothing older than twelve months survives')
  from public.events where occurred_at < now() - interval '12 months';
select assert(count(*) > 0, 'while recent events are untouched')
  from public.events where occurred_at >= now() - interval '12 months';

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
