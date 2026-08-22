\set ON_ERROR_STOP on
\pset pager off

-- Assertions for 0017_notifications.sql: who a comment notifies, and who it
-- must not.
--
-- The fan-out is a trigger, so nothing in either client gets a say in it — which
-- is the point, and also why it is worth proving here rather than by posting
-- comments in the app and watching. The three rules that would be expensive to
-- get wrong are all about *not* notifying: never yourself, never across a block,
-- and never someone who cannot open the match the comment is on. The last one
-- matters most, because the notification carries a snippet of the comment with
-- it.

create or replace function assert(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'FAIL: %', what; end if;
  raise notice 'ok: %', what;
end $$;

-- ---------------------------------------------------------------------------
-- Cast: Ana owns a match and shares it to her followers. Ben and Cal follow her,
-- so both can see it. Dee follows nobody and cannot.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaa0000-0000-0000-0000-00000000000a', 'ana@example.com',
   '{"first_name":"Ana","last_name":"Ruiz"}'),
  ('bbbb0000-0000-0000-0000-00000000000b', 'ben@example.com',
   '{"first_name":"Ben","last_name":"Shaw"}'),
  ('cccc0000-0000-0000-0000-00000000000c', 'cal@example.com',
   '{"first_name":"Cal","last_name":"Frost"}'),
  ('dddd0000-0000-0000-0000-00000000000d', 'dee@example.com',
   '{"first_name":"Dee","last_name":"Okafor"}');

insert into public.videos (id, owner_id, title, key, content_type, size_bytes, part_size_bytes, status, visibility)
values ('aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'Ana vs Ben', 'videos/ana.mov', 'video/quicktime', 1, 1, 'ready', 'private');

insert into public.follows (follower_id, followee_id) values
  ('bbbb0000-0000-0000-0000-00000000000b', 'aaaa0000-0000-0000-0000-00000000000a'),
  ('cccc0000-0000-0000-0000-00000000000c', 'aaaa0000-0000-0000-0000-00000000000a');
insert into public.match_shares (video_id, user_id)
values ('aaaa1111-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-00000000000a');

select assert(public.can_user_view_video('bbbb0000-0000-0000-0000-00000000000b',
                                         'aaaa1111-0000-0000-0000-000000000001'),
              'a follower of the sharer can view the match');
select assert(not public.can_user_view_video('dddd0000-0000-0000-0000-00000000000d',
                                             'aaaa1111-0000-0000-0000-000000000001'),
              'and someone outside cannot');

-- ---------------------------------------------------------------------------
-- 1. The owner hears about a comment on their own match
-- ---------------------------------------------------------------------------
set request.uid = 'bbbb0000-0000-0000-0000-00000000000b';
insert into public.match_comments (id, video_id, author_id, body)
values ('b0000000-0000-0000-0000-000000000001',
        'aaaa1111-0000-0000-0000-000000000001',
        'bbbb0000-0000-0000-0000-00000000000b',
        'great backhand at 12:34');

select assert(count(*) = 1, 'Ben''s comment notifies exactly one person')
  from public.notifications;
select assert(user_id = 'aaaa0000-0000-0000-0000-00000000000a' and kind = 'reply',
              'and that person is Ana, the match owner, as a reply')
  from public.notifications;
select assert(body = 'great backhand at 12:34', 'the comment is snapshotted with it')
  from public.notifications;

-- ---------------------------------------------------------------------------
-- 2. A later comment reaches everyone already in the thread, and nobody twice
--
-- Cal has not commented yet, so this is Ana's reply landing on Ben (in the
-- thread) — and not on Ana herself.
-- ---------------------------------------------------------------------------
set request.uid = 'aaaa0000-0000-0000-0000-00000000000a';
insert into public.match_comments (id, video_id, author_id, body)
values ('a0000000-0000-0000-0000-000000000002',
        'aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'thanks!');

select assert(count(*) = 1, 'Ana''s reply notifies exactly one person')
  from public.notifications where comment_id = 'a0000000-0000-0000-0000-000000000002';
select assert(user_id = 'bbbb0000-0000-0000-0000-00000000000b',
              'and it is Ben, who is in the thread')
  from public.notifications where comment_id = 'a0000000-0000-0000-0000-000000000002';
select assert(count(*) = 0, 'nobody is ever notified about their own comment')
  from public.notifications n
  join public.match_comments c on c.id = n.comment_id
 where n.user_id = c.author_id;

-- ---------------------------------------------------------------------------
-- 3. An @tag notifies someone who was not in the thread, as a mention
-- ---------------------------------------------------------------------------
set request.uid = 'bbbb0000-0000-0000-0000-00000000000b';
insert into public.match_comments (id, video_id, author_id, body)
values ('b0000000-0000-0000-0000-000000000003',
        'aaaa1111-0000-0000-0000-000000000001',
        'bbbb0000-0000-0000-0000-00000000000b',
        'watch this @[Cal Frost](cccc0000-0000-0000-0000-00000000000c)');

select assert(kind = 'mention', 'being tagged is a mention, not a reply')
  from public.notifications
 where comment_id = 'b0000000-0000-0000-0000-000000000003'
   and user_id = 'cccc0000-0000-0000-0000-00000000000c';
select assert(count(*) = 2, 'the tagged player and the match owner both hear about it')
  from public.notifications where comment_id = 'b0000000-0000-0000-0000-000000000003';

-- Being tagged *and* in the thread is one row, and it is the mention.
set request.uid = 'aaaa0000-0000-0000-0000-00000000000a';
insert into public.match_comments (id, video_id, author_id, body)
values ('a0000000-0000-0000-0000-000000000004',
        'aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'agreed @[Ben Shaw](bbbb0000-0000-0000-0000-00000000000b)');

select assert(count(*) = 1, 'tagged and in the thread is still a single notification')
  from public.notifications
 where comment_id = 'a0000000-0000-0000-0000-000000000004'
   and user_id = 'bbbb0000-0000-0000-0000-00000000000b';
select assert(kind = 'mention', 'and the mention wins over the reply')
  from public.notifications
 where comment_id = 'a0000000-0000-0000-0000-000000000004'
   and user_id = 'bbbb0000-0000-0000-0000-00000000000b';

-- ---------------------------------------------------------------------------
-- 4. An @tag is not a grant of access
--
-- Dee cannot open this match. Tagging her must not tell her it exists, and must
-- certainly not post her a copy of what was said in it.
-- ---------------------------------------------------------------------------
insert into public.match_comments (id, video_id, author_id, body)
values ('a0000000-0000-0000-0000-000000000005',
        'aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'hi @[Dee Okafor](dddd0000-0000-0000-0000-00000000000d)');

select assert(count(*) = 0, 'tagging someone who cannot see the match notifies them of nothing')
  from public.notifications where user_id = 'dddd0000-0000-0000-0000-00000000000d';

-- Ana owns the match, but she does not follow Dee — and you can only tag
-- someone you follow. So even the owner's tag grants nothing here.
select assert(not public.can_user_view_video('dddd0000-0000-0000-0000-00000000000d',
                                             'aaaa1111-0000-0000-0000-000000000001'),
              'a tag without a follow grants no access, even from the owner');

-- Once Ana follows Dee, the same tag is Ana choosing to show her the match: it
-- lands in Dee's library, and only then does the notification follow.
insert into public.follows (follower_id, followee_id)
values ('aaaa0000-0000-0000-0000-00000000000a', 'dddd0000-0000-0000-0000-00000000000d');

insert into public.match_comments (id, video_id, author_id, body)
values ('a0000000-0000-0000-0000-000000000009',
        'aaaa1111-0000-0000-0000-000000000001',
        'aaaa0000-0000-0000-0000-00000000000a',
        'hi again @[Dee Okafor](dddd0000-0000-0000-0000-00000000000d)');

select assert(public.can_user_view_video('dddd0000-0000-0000-0000-00000000000d',
                                         'aaaa1111-0000-0000-0000-000000000001'),
              'the owner''s tag put the match in Dee''s library');
select assert(count(*) = 1, 'and now Dee is notified, as a mention')
  from public.notifications
 where user_id = 'dddd0000-0000-0000-0000-00000000000d' and kind = 'mention';

-- A tag from someone who is NOT in the match grants nothing — even when they do
-- follow the person they are tagging. Ben can comment (he follows Ana) but he is
-- not in the match, so he cannot use a tag to hand Ana's private footage on.
insert into auth.users (id, email, raw_user_meta_data) values
  ('eeee0000-0000-0000-0000-00000000000e', 'eve@example.com',
   '{"first_name":"Eve","last_name":"Stone"}');
insert into public.follows (follower_id, followee_id)
values ('bbbb0000-0000-0000-0000-00000000000b', 'eeee0000-0000-0000-0000-00000000000e');

set request.uid = 'bbbb0000-0000-0000-0000-00000000000b';
insert into public.match_comments (id, video_id, author_id, body)
values ('b0000000-0000-0000-0000-00000000000a',
        'aaaa1111-0000-0000-0000-000000000001',
        'bbbb0000-0000-0000-0000-00000000000b',
        'look @[Eve Stone](eeee0000-0000-0000-0000-00000000000e)');

select assert(not public.can_user_view_video('eeee0000-0000-0000-0000-00000000000e',
                                             'aaaa1111-0000-0000-0000-000000000001'),
              'a tag from someone outside the match grants no access');
select assert(count(*) = 0, 'and notifies the stranger of nothing')
  from public.notifications where user_id = 'eeee0000-0000-0000-0000-00000000000e';

-- ---------------------------------------------------------------------------
-- 5. A block silences the notification, in both directions
-- ---------------------------------------------------------------------------
insert into public.user_blocks (blocker_id, blocked_id)
values ('cccc0000-0000-0000-0000-00000000000c', 'bbbb0000-0000-0000-0000-00000000000b');

insert into public.match_comments (id, video_id, author_id, body)
values ('b0000000-0000-0000-0000-000000000006',
        'aaaa1111-0000-0000-0000-000000000001',
        'bbbb0000-0000-0000-0000-00000000000b',
        'again @[Cal Frost](cccc0000-0000-0000-0000-00000000000c)');

select assert(count(*) = 0, 'a blocked author cannot reach the blocker by tagging them')
  from public.notifications
 where comment_id = 'b0000000-0000-0000-0000-000000000006'
   and user_id = 'cccc0000-0000-0000-0000-00000000000c';

-- ---------------------------------------------------------------------------
-- 6. Malformed markup is text, not a crash
--
-- The trigger runs inside the comment's own transaction, so anything that could
-- raise in here would take the comment with it.
-- ---------------------------------------------------------------------------
insert into public.match_comments (id, video_id, author_id, body)
values ('b0000000-0000-0000-0000-000000000007',
        'aaaa1111-0000-0000-0000-000000000001',
        'bbbb0000-0000-0000-0000-00000000000b',
        'nonsense @[Nobody](not-a-uuid) and @[Half](aaaa) and a bare @tag');

select assert(count(*) = 1, 'a comment full of broken tags still posts, notifying only the owner')
  from public.notifications where comment_id = 'b0000000-0000-0000-0000-000000000007';

-- ---------------------------------------------------------------------------
-- 7. The inbox reads back under RLS, and only your own
-- ---------------------------------------------------------------------------
set request.uid = 'aaaa0000-0000-0000-0000-00000000000a';
select assert(count(*) > 0, 'Ana can list her own notifications')
  from public.list_notifications(50);
select assert(bool_and(actor_name is not null and video_title = 'Ana vs Ben'),
              'each one names who caused it and which match')
  from public.list_notifications(50);

-- Eve was tagged by someone outside the match, so nothing reached her. She is
-- the one with an empty inbox now that Dee has been let in.
set request.uid = 'eeee0000-0000-0000-0000-00000000000e';
select assert(count(*) = 0, 'Eve''s inbox is empty — list_notifications is scoped to the caller')
  from public.list_notifications(50);

-- ---------------------------------------------------------------------------
-- 8. Deleting the comment takes the notification with it
-- ---------------------------------------------------------------------------
delete from public.match_comments where id = 'b0000000-0000-0000-0000-000000000001';
select assert(count(*) = 0, 'deleting a comment clears the notifications about it')
  from public.notifications where comment_id = 'b0000000-0000-0000-0000-000000000001';

-- ---------------------------------------------------------------------------
-- 9. The @ picker only offers people you follow
-- ---------------------------------------------------------------------------
set request.uid = 'aaaa0000-0000-0000-0000-00000000000a';
select assert(count(*) = 1, 'Ana''s @ picker offers Dee, who she follows')
  from public.search_followed_users('Okafor');
select assert(count(*) = 0, 'and not Cal, who she does not follow')
  from public.search_followed_users('Frost');
select assert(count(*) = 1, 'while the directory search still finds Cal')
  from public.search_users('Frost');

do $$ begin raise notice 'ALL ASSERTIONS PASSED'; end $$;
