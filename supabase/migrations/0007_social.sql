-- Social layer: following, per-participant "share to followers", likes, comments,
-- and a merged home feed. Follows existing conventions (all policies `to
-- authenticated`; security-definer helpers to avoid RLS recursion; acyclic refs).
-- Run in the Supabase SQL editor after 0006_participant_edit.sql.

-- ---------------------------------------------------------------------------
-- follows: who follows whom.
-- ---------------------------------------------------------------------------
create table if not exists public.follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  followee_id uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists follows_follower_idx on public.follows (follower_id);
create index if not exists follows_followee_idx on public.follows (followee_id);

alter table public.follows enable row level security;

-- Follow graph is readable by any signed-in user (for counts/lists), like profiles.
create policy "follows readable by authenticated"
  on public.follows for select to authenticated using (true);
-- You only create/remove your own follows.
create policy "manage own follows"
  on public.follows for all to authenticated
  using (follower_id = auth.uid()) with check (follower_id = auth.uid());

-- ---------------------------------------------------------------------------
-- match_shares: a participant/owner posts a match to THEIR followers. Emergent
-- "followers" visibility — each person in a match decides independently.
-- ---------------------------------------------------------------------------
create table if not exists public.match_shares (
  video_id   uuid not null references public.videos (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);
create index if not exists match_shares_user_idx on public.match_shares (user_id);
create index if not exists match_shares_video_idx on public.match_shares (video_id);

alter table public.match_shares enable row level security;

-- ---------------------------------------------------------------------------
-- can_view_video: single source of truth for "may this user see this video".
-- SECURITY DEFINER so it reads underlying tables without RLS — this both powers
-- the videos SELECT policy and lets the social tables' policies reference view
-- access without any policy recursion (same trick as can_edit_video).
-- ---------------------------------------------------------------------------
create or replace function public.can_view_video(p_video_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.videos v
    where v.id = p_video_id and v.deleted_at is null and (
      v.owner_id = auth.uid()
      or v.visibility = 'public'
      or exists (select 1 from public.library_items li
                 where li.video_id = v.id and li.user_id = auth.uid())
      or exists (select 1 from public.match_shares ms
                 join public.follows f on f.followee_id = ms.user_id
                 where ms.video_id = v.id and f.follower_id = auth.uid())
    )
  );
$$;
grant execute on function public.can_view_video(uuid) to authenticated;

-- Replace the videos SELECT policy with the helper (adds the follower-share path,
-- and keeps a single, recursion-free definition of visibility).
drop policy if exists "videos readable by owner, library or public" on public.videos;
create policy "videos readable"
  on public.videos for select to authenticated
  using (public.can_view_video(id));

-- match_shares policies (defined after can_edit_video/can_view_video exist).
create policy "read shares of visible videos"
  on public.match_shares for select to authenticated
  using (public.can_view_video(video_id));
-- Only someone IN the match (owner or participant) can post it to their followers.
create policy "manage own shares"
  on public.match_shares for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_edit_video(video_id));

-- ---------------------------------------------------------------------------
-- match_likes
-- ---------------------------------------------------------------------------
create table if not exists public.match_likes (
  video_id   uuid not null references public.videos (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (video_id, user_id)
);
create index if not exists match_likes_video_idx on public.match_likes (video_id);

alter table public.match_likes enable row level security;

create policy "read likes of visible videos"
  on public.match_likes for select to authenticated
  using (public.can_view_video(video_id));
create policy "manage own likes"
  on public.match_likes for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.can_view_video(video_id));

-- ---------------------------------------------------------------------------
-- match_comments (flat; author or match owner can delete)
-- ---------------------------------------------------------------------------
create table if not exists public.match_comments (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid not null references public.videos (id) on delete cascade,
  author_id  uuid not null references auth.users (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists match_comments_video_idx on public.match_comments (video_id, created_at);

alter table public.match_comments enable row level security;

create policy "read comments of visible videos"
  on public.match_comments for select to authenticated
  using (public.can_view_video(video_id));
create policy "author adds comments"
  on public.match_comments for insert to authenticated
  with check (author_id = auth.uid() and public.can_view_video(video_id));
create policy "author or owner deletes comments"
  on public.match_comments for delete to authenticated
  using (
    author_id = auth.uid()
    or exists (select 1 from public.videos v where v.id = video_id and v.owner_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- get_feed: home feed = matches shared by people I follow + my own library,
-- deduped by video (newest event wins), with counts + participant names.
-- SECURITY DEFINER, explicitly scoped to auth.uid().
-- ---------------------------------------------------------------------------
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
    d.feed_at
  from deduped d
  join public.videos v on v.id = d.video_id and v.deleted_at is null
  left join public.profiles op on op.id = v.owner_id
  left join public.profiles sp on sp.id = d.shared_by
  order by d.feed_at desc
  limit p_limit;
$$;
grant execute on function public.get_feed(int) to authenticated;
