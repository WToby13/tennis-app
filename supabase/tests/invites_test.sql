\set ON_ERROR_STOP on
\pset pager off

-- Helper: fail loudly.
create or replace function assert(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok: %', what;
end $$;

-- ---------------------------------------------------------------------------
-- Cast
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'toby@example.com',
   '{"first_name":"Toby","last_name":"Keating","handedness":"right"}');

insert into public.videos (id, owner_id, title, key, content_type, size_bytes, part_size_bytes, status, visibility)
values ('aaaaaaaa-0000-0000-0000-000000000001',
        '11111111-1111-1111-1111-111111111111',
        'Sunday singles', 'videos/a.mov', 'video/quicktime', 1, 1, 'ready', 'private');

set request.uid = '11111111-1111-1111-1111-111111111111';

-- ---------------------------------------------------------------------------
-- 1. The reported flow: tag a stranger by email before upload
-- ---------------------------------------------------------------------------
select public.set_participants(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"userId":null,"displayName":"Guillem Torner","email":"guillem.torner@example.com"}]'::jsonb);

select assert(count(*) = 1, 'one participant row after tagging by email') from public.video_participants;
select assert(user_id is null and invite_token is not null,
              'email guest is pending and has an invite token')
  from public.video_participants;

\gset
select invite_token as tok from public.video_participants \gset

-- ---------------------------------------------------------------------------
-- 2. He signs up via the share link with a DIFFERENT address
--    (the old code keyed the claim on the address, so this never linked)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('22222222-2222-2222-2222-222222222222', 'guillem@gmail.com',
   '{"first_name":"Guillem","last_name":"Torner","handedness":"right"}');

select assert(user_id is null, 'address mismatch means signup alone does not link him')
  from public.video_participants;

-- ---------------------------------------------------------------------------
-- 3. The token claims it anyway — this is the fix
-- ---------------------------------------------------------------------------
set request.uid = '22222222-2222-2222-2222-222222222222';
select public.claim_invite(:'tok');

select assert(count(*) = 1, 'still exactly one row for him (no duplicate person)')
  from public.video_participants where video_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select assert(user_id = '22222222-2222-2222-2222-222222222222', 'claim linked the account')
  from public.video_participants;
select assert(display_name = 'Guillem Torner', 'name came from his profile, not the email prefix')
  from public.video_participants;
select assert(count(*) = 1, 'claiming granted library access')
  from public.library_items
 where user_id = '22222222-2222-2222-2222-222222222222'
   and video_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- Re-opening the emailed link is harmless.
select public.claim_invite(:'tok');
select assert(count(*) = 1, 'claiming twice is idempotent') from public.video_participants;

-- ---------------------------------------------------------------------------
-- 4. Tagging the same human two ways collapses to one row
-- ---------------------------------------------------------------------------
set request.uid = '11111111-1111-1111-1111-111111111111';
select public.set_participants(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"userId":"22222222-2222-2222-2222-222222222222","displayName":"Guillem Torner","email":null},
    {"userId":null,"displayName":"guillem.torner","email":"guillem@gmail.com"}]'::jsonb);
select assert(count(*) = 1, 'account + matching address dedupe to one participant')
  from public.video_participants where video_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 5. Tagging by an address that already belongs to an account links it now
--    (the old set_participants left this a dead guest row forever)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('33333333-3333-3333-3333-333333333333', 'maria@example.com',
   '{"first_name":"Maria","last_name":"Ruiz","handedness":"left"}');

select public.set_participants(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"userId":"22222222-2222-2222-2222-222222222222","displayName":"Guillem Torner","email":null},
    {"userId":null,"displayName":"maria","email":"MARIA@example.com"}]'::jsonb);

select assert(user_id = '33333333-3333-3333-3333-333333333333',
              'an address that is already an account links straight away')
  from public.video_participants where lower(email) = 'maria@example.com';
select assert(display_name = 'Maria Ruiz', 'and is named from her profile, not what was typed')
  from public.video_participants where user_id = '33333333-3333-3333-3333-333333333333';
select assert(count(*) = 1, 'she gets library access with no invite round trip')
  from public.library_items
 where user_id = '33333333-3333-3333-3333-333333333333'
   and video_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 6. Editing the list must not invalidate a pending invite link
-- ---------------------------------------------------------------------------
select public.set_participants(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"userId":null,"displayName":"Sam","email":"sam@example.com"}]'::jsonb);
select invite_token as samtok from public.video_participants where email = 'sam@example.com' \gset

select public.set_participants(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"userId":null,"displayName":"Sam","email":"sam@example.com"},
    {"userId":null,"displayName":"Court neighbour","email":null}]'::jsonb);
select assert(invite_token = :'samtok', 'editing the list keeps Sam''s invite link alive')
  from public.video_participants where email = 'sam@example.com';

-- Removal still works.
select public.set_participants(
  'aaaaaaaa-0000-0000-0000-000000000001',
  '[{"userId":null,"displayName":"Sam","email":"sam@example.com"}]'::jsonb);
select assert(count(*) = 1, 'dropping someone from the list removes them')
  from public.video_participants where video_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- Removing a linked participant revokes the library access the tag granted.
select assert(count(*) = 0, 'untagging Maria took the match back out of her library')
  from public.library_items
 where user_id = '33333333-3333-3333-3333-333333333333'
   and video_id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 7. Invite tokens must not be readable by ordinary clients
-- ---------------------------------------------------------------------------
set role authenticated;
select assert(count(*) >= 0, 'a signed-in user can still read participants')
  from public.video_participants;
do $$
begin
  begin
    perform invite_token from public.video_participants;
    raise exception 'FAIL: invite_token was readable by authenticated';
  exception when insufficient_privilege then
    raise notice 'ok: invite_token is hidden from authenticated';
  end;
end $$;
reset role;

-- Editors get them through the RPC.
set request.uid = '11111111-1111-1111-1111-111111111111';
select assert(count(*) = 1, 'the editor RPC returns the pending invite with its token')
  from public.participant_invites('aaaaaaaa-0000-0000-0000-000000000001')
 where invite_token is not null and not claimed;

-- A non-editor cannot.
set request.uid = '33333333-3333-3333-3333-333333333333';
do $$
begin
  begin
    perform * from public.participant_invites('aaaaaaaa-0000-0000-0000-000000000001');
    raise exception 'FAIL: a non-editor read the invite tokens';
  exception when others then
    if sqlerrm like 'FAIL:%' then raise; end if;
    raise notice 'ok: non-editors are refused the invite tokens (%)', sqlerrm;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Signup-by-matching-address still works (the convenience path)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('44444444-4444-4444-4444-444444444444', 'sam@example.com',
   '{"first_name":"Sam","last_name":"Okafor","handedness":"right"}');
select assert(user_id = '44444444-4444-4444-4444-444444444444',
              'signing up with the invited address still claims it')
  from public.video_participants where video_id = 'aaaaaaaa-0000-0000-0000-000000000001';
select assert(display_name = 'Sam Okafor', 'and refreshes the placeholder name')
  from public.video_participants where video_id = 'aaaaaaaa-0000-0000-0000-000000000001';

select 'ALL ASSERTIONS PASSED' as result;
