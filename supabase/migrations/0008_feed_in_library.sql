-- Add `in_library` to the home feed so the UI can show whether a match is already
-- in the viewer's profile (the "add to profile" action state).
-- Run in the Supabase SQL editor after 0007_social.sql.

-- Adding a column changes the function's return type, which `create or replace`
-- can't do — drop the 0007 version first. Safe: nothing else in the DB depends on it.
drop function if exists public.get_feed(int);

create or replace function public.get_feed(p_limit int default 50)
returns table (
  id              uuid,
  owner_id        uuid,
  title           text,
  status          text,
  duration_s      double precision,
  size_bytes      bigint,
  created_at      timestamptz,
  visibility      text,
  author_name     text,
  shared_by       uuid,
  shared_by_name  text,
  participant_names text,
  like_count      bigint,
  comment_count   bigint,
  liked_by_me     boolean,
  in_library      boolean,
  feed_at         timestamptz
)
language sql security definer set search_path = public stable as $$
  with me as (select auth.uid() as uid),
  candidates as (
    select ms.video_id, ms.user_id as shared_by, ms.created_at as feed_at
    from public.match_shares ms
    join public.follows f on f.followee_id = ms.user_id and f.follower_id = (select uid from me)
    union all
    select li.video_id, null::uuid as shared_by, li.added_at as feed_at
    from public.library_items li
    where li.user_id = (select uid from me)
  ),
  deduped as (
    select distinct on (video_id) video_id, shared_by, feed_at
    from candidates
    order by video_id, feed_at desc
  )
  select
    v.id, v.owner_id, v.title, v.status, v.duration_s, v.size_bytes, v.created_at, v.visibility,
    op.display_name as author_name,
    d.shared_by,
    sp.display_name as shared_by_name,
    (select string_agg(vp.display_name, ', ' order by vp.created_at)
       from public.video_participants vp where vp.video_id = v.id) as participant_names,
    (select count(*) from public.match_likes l where l.video_id = v.id) as like_count,
    (select count(*) from public.match_comments c where c.video_id = v.id) as comment_count,
    exists (select 1 from public.match_likes l
            where l.video_id = v.id and l.user_id = (select uid from me)) as liked_by_me,
    exists (select 1 from public.library_items li
            where li.video_id = v.id and li.user_id = (select uid from me)) as in_library,
    d.feed_at
  from deduped d
  join public.videos v on v.id = d.video_id and v.deleted_at is null
  left join public.profiles op on op.id = v.owner_id
  left join public.profiles sp on sp.id = d.shared_by
  order by d.feed_at desc
  limit p_limit;
$$;
grant execute on function public.get_feed(int) to authenticated;
