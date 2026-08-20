\set ON_ERROR_STOP on
\pset pager off

-- Assertions for 0014_moderation.sql: blocking, reporting, and what an account
-- deletion actually leaves behind.
--
-- The last section is the one that matters most. "Delete account" is an App
-- Store requirement (5.1.1(v)) and a promise in the privacy policy, so what
-- survives the delete is a claim we make in writing — worth proving rather than
-- assuming, especially since `video_participants.user_id` is ON DELETE SET NULL
-- and so does *not* take the row with it.

create or replace function assert(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok: %', what;
end $$;

-- ---------------------------------------------------------------------------
-- Cast: Ana records matches. Ben follows her. Cal is a nuisance.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaa0000-0000-0000-0000-00000000000a', 'ana@example.com',
   '{"first_name":"Ana","last_name":"Ruiz","handedness":"right"}'),
  ('bbbb0000-0000-0000-0000-00000000000b', 'ben@example.com',
   '{"first_name":"Ben","last_name":"Shaw","handedness":"left"}'),
  ('cccc0000-0000-0000-0000-00000000000c', 'cal@example.com',
   '{"first_name":"Cal","last_name":"Frost","handedness":"right"}');

insert into public.videos (id, owner_id, title, key, content_type, size_bytes, part_size_bytes, status, visibility)
values ('aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'Ana vs Ben', 'videos/ana.mov', 'video/quicktime', 1, 1, 'ready', 'private'),
       ('cccc1111-0000-0000-0000-000000000001',
        'cccc0000-0000-0000-0000-00000000000c',
        'Cal solo', 'videos/cal.mov', 'video/quicktime', 1, 1, 'ready', 'private');

-- Ben follows both, and both post their match to their followers.
insert into public.follows (follower_id, followee_id) values
  ('bbbb0000-0000-0000-0000-00000000000b', 'aaaa0000-0000-0000-0000-00000000000a'),
  ('bbbb0000-0000-0000-0000-00000000000b', 'cccc0000-0000-0000-0000-00000000000c');
insert into public.match_shares (video_id, user_id) values
  ('aaaa1111-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-00000000000a'),
  ('cccc1111-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-00000000000c');

-- ---------------------------------------------------------------------------
-- 1. get_feed still carries in_library
--
-- 0008 added that column and the "add to profile" button in both clients reads
-- it. 0014 redefines get_feed, so this guards against the redefinition being
-- rebased on 0007 and quietly dropping it.
-- ---------------------------------------------------------------------------
set request.uid = 'bbbb0000-0000-0000-0000-00000000000b';

select assert(pg_get_function_result('public.get_feed'::regproc) like '%in_library%',
              'get_feed still returns in_library after 0014');
select assert(count(*) = 2, 'Ben sees both followed matches before blocking')
  from public.get_feed(50);

-- ---------------------------------------------------------------------------
-- 2. Blocking removes that person's matches from the feed
-- ---------------------------------------------------------------------------
insert into public.user_blocks (blocker_id, blocked_id)
values ('bbbb0000-0000-0000-0000-00000000000b', 'cccc0000-0000-0000-0000-00000000000c');

select assert(count(*) = 1, 'blocking Cal drops his match out of Ben''s feed')
  from public.get_feed(50);
select assert(bool_and(owner_id = 'aaaa0000-0000-0000-0000-00000000000a'),
              'the match still there is Ana''s')
  from public.get_feed(50);

-- ---------------------------------------------------------------------------
-- 3. The block is symmetric — Cal loses Ben too
-- ---------------------------------------------------------------------------
set request.uid = 'cccc0000-0000-0000-0000-00000000000c';
select assert(public.is_blocked('bbbb0000-0000-0000-0000-00000000000b'),
              'is_blocked is symmetric: Cal is blocked from Ben as well');

-- ---------------------------------------------------------------------------
-- 4. Blocking severs the follow edges both ways
--
-- Without the trigger the follow row outlives the block and silently restores
-- the connection the moment the block is lifted.
-- ---------------------------------------------------------------------------
select assert(count(*) = 0, 'blocking severed the follow between Ben and Cal')
  from public.follows
 where (follower_id = 'bbbb0000-0000-0000-0000-00000000000b' and followee_id = 'cccc0000-0000-0000-0000-00000000000c')
    or (follower_id = 'cccc0000-0000-0000-0000-00000000000c' and followee_id = 'bbbb0000-0000-0000-0000-00000000000b');
select assert(count(*) = 1, 'Ben''s unrelated follow of Ana survived')
  from public.follows where follower_id = 'bbbb0000-0000-0000-0000-00000000000b';

-- ---------------------------------------------------------------------------
-- 5. A report outlives the content it is about
--
-- The whole point of storing the target as a bare (kind, id) with a snapshot
-- and no foreign key: the first thing a reported user does is delete the
-- comment.
-- ---------------------------------------------------------------------------
insert into public.library_items (video_id, user_id, added_via)
values ('aaaa1111-0000-0000-0000-000000000001', 'cccc0000-0000-0000-0000-00000000000c', 'share');

insert into public.match_comments (id, video_id, author_id, body)
values ('dddd1111-0000-0000-0000-000000000001',
        'aaaa1111-0000-0000-0000-000000000001',
        'cccc0000-0000-0000-0000-00000000000c', 'something objectionable');

insert into public.content_reports
  (reporter_id, target_kind, target_id, reported_user_id, content_snapshot, reason, details)
values ('aaaa0000-0000-0000-0000-00000000000a', 'comment',
        'dddd1111-0000-0000-0000-000000000001',
        'cccc0000-0000-0000-0000-00000000000c', 'something objectionable', 'abuse', null);

delete from public.match_comments where id = 'dddd1111-0000-0000-0000-000000000001';

select assert(count(*) = 1, 'the report survived deletion of the comment it was about')
  from public.content_reports;
select assert(content_snapshot = 'something objectionable' and reported_user_id is not null,
              'and still names the account and what was said')
  from public.content_reports;

-- ---------------------------------------------------------------------------
-- 6. Deleting an account takes the personal data with it
--
-- Cal asks to be deleted. Everything keyed to him must go — and crucially he
-- also appears as a participant on Ana's match, where the FK is SET NULL rather
-- than CASCADE, so the row survives and has to be scrubbed by the delete path
-- rather than by the database.
-- ---------------------------------------------------------------------------
set request.uid = 'aaaa0000-0000-0000-0000-00000000000a';
insert into public.video_participants (video_id, user_id, display_name, email, added_by)
values ('aaaa1111-0000-0000-0000-000000000001',
        'cccc0000-0000-0000-0000-00000000000c', 'Cal Frost', 'cal@example.com',
        'aaaa0000-0000-0000-0000-00000000000a');

-- What DELETE /api/users/me does, in the same order: scrub the rows the FKs
-- will only null out, then delete the user and let the cascades run.
update public.video_participants
   set display_name = 'Former Ojo player', email = null, invite_token = null
 where user_id = 'cccc0000-0000-0000-0000-00000000000c';
delete from auth.users where id = 'cccc0000-0000-0000-0000-00000000000c';

select assert(count(*) = 0, 'his videos cascaded away')
  from public.videos where owner_id = 'cccc0000-0000-0000-0000-00000000000c';
select assert(count(*) = 0, 'his profile cascaded away')
  from public.profiles where id = 'cccc0000-0000-0000-0000-00000000000c';
select assert(count(*) = 0, 'his library rows cascaded away')
  from public.library_items where user_id = 'cccc0000-0000-0000-0000-00000000000c';
select assert(count(*) = 0, 'blocks naming him cascaded away')
  from public.user_blocks
 where blocker_id = 'cccc0000-0000-0000-0000-00000000000c'
    or blocked_id = 'cccc0000-0000-0000-0000-00000000000c';

select assert(count(*) = 0, 'no trace of his name or address is left on anyone else''s match')
  from public.video_participants
 where display_name = 'Cal Frost' or email = 'cal@example.com';
select assert(count(*) = 1, 'the participant slot itself remains, anonymised')
  from public.video_participants
 where video_id = 'aaaa1111-0000-0000-0000-000000000001'
   and display_name = 'Former Ojo player' and user_id is null;

-- The report is deliberately kept: it is the record of a moderation decision,
-- and reported_user_id nulling out is what un-links it from the person.
select assert(count(*) = 1, 'the moderation record survives the account deletion')
  from public.content_reports;
select assert(reported_user_id is null, 'but no longer points at a live account')
  from public.content_reports;

-- ---------------------------------------------------------------------------
-- 7. People search does not surface a block (0016)
--
-- Search became a browsable directory when it moved behind the magnifying glass
-- on Home, so it has to hide blocks in BOTH directions. The half that is easy
-- to get wrong is the second one: someone who blocked you must not be able to
-- find you by name, and the client cannot filter that itself because
-- user_blocks RLS hides "who blocked me" on purpose.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('dddd0000-0000-0000-0000-00000000000d', 'dee@example.com',
   '{"first_name":"Dee","last_name":"Marlow","handedness":"right"}'),
  ('eeee0000-0000-0000-0000-00000000000e', 'eve@example.com',
   '{"first_name":"Eve","last_name":"Marlow","handedness":"left"}');

set request.uid = 'dddd0000-0000-0000-0000-00000000000d';
select assert(count(*) = 1, 'Dee finds Eve by surname before any block')
  from public.search_users('Marlow');
select assert(bool_and(id <> 'dddd0000-0000-0000-0000-00000000000d'),
              'and search never lists the searcher back to themselves')
  from public.search_users('Marlow');

-- Dee blocks Eve. Eve must vanish from Dee's search...
insert into public.user_blocks (blocker_id, blocked_id)
values ('dddd0000-0000-0000-0000-00000000000d', 'eeee0000-0000-0000-0000-00000000000e');
select assert(count(*) = 0, 'blocking Eve removes her from Dee''s search')
  from public.search_users('Marlow');

-- ...and, the direction a client-side filter cannot see, Dee must vanish from
-- Eve's, even though Eve is not the one who blocked.
set request.uid = 'eeee0000-0000-0000-0000-00000000000e';
select assert(count(*) = 0, 'and hides Dee from Eve, who cannot see the block at all')
  from public.search_users('Marlow');

-- An unrelated searcher still sees both.
set request.uid = 'aaaa0000-0000-0000-0000-00000000000a';
select assert(count(*) = 2, 'the block is private: Ana still finds both Marlows')
  from public.search_users('Marlow');

-- A name with a LIKE metacharacter matches itself rather than acting as a wildcard.
insert into auth.users (id, email, raw_user_meta_data) values
  ('ffff0000-0000-0000-0000-00000000000f', 'pct@example.com',
   '{"first_name":"Jo_n","last_name":"Percent","handedness":"right"}');
select assert(count(*) = 1, 'an underscore in a query is matched literally, not as a wildcard')
  from public.search_users('Jo_n');
select assert(count(*) = 0, 'so it does not match the name it would wildcard onto')
  from public.search_users('John');

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
