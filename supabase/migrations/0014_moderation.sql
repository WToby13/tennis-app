-- Moderation: blocking and content reports.
--
-- Required by App Store Review Guideline 1.2 — an app carrying user-generated
-- content (here: matches posted to followers, plus comments) must let a user
-- report objectionable content and block the person who posted it, and must act
-- on reports. Follows existing conventions: policies `to authenticated`,
-- security-definer helpers to keep RLS non-recursive.
-- Run in the Supabase SQL editor after 0013_analysis_windows.sql.

-- ---------------------------------------------------------------------------
-- user_blocks: I never want to see this person, and they never see me.
-- ---------------------------------------------------------------------------
create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

-- A block is private to the person who made it: the blocked user is never told.
create policy "read own blocks"
  on public.user_blocks for select to authenticated
  using (blocker_id = auth.uid());
create policy "manage own blocks"
  on public.user_blocks for all to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- ---------------------------------------------------------------------------
-- is_blocked: is there a block in EITHER direction between me and this user?
--
-- Symmetric on purpose. Apple's requirement is that a blocked user's content
-- disappears for the blocker; making it mutual also stops the blocked user
-- following the blocker's matches back into their own feed, which is the
-- behaviour a person doing the blocking actually expects.
--
-- SECURITY DEFINER so the block table can be consulted from inside other
-- tables' policies without those policies recursing through user_blocks' own.
-- ---------------------------------------------------------------------------
create or replace function public.is_blocked(p_other uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = p_other)
       or (b.blocker_id = p_other and b.blocked_id = auth.uid())
  );
$$;
grant execute on function public.is_blocked(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- content_reports: a user flags a match or a comment.
--
-- Write-only from the app's point of view — a reporter can see what they filed,
-- nobody else can, and triage happens under the service role. `resolved_at` is
-- what the 24-hour commitment in the EULA is measured against.
--
-- The target is stored as a bare (kind, id) pair with no foreign key, and the
-- offending text is snapshotted alongside it. That's deliberate: the first
-- thing a reported user tends to do is delete the comment, and an FK — whether
-- it cascaded or nulled — would take the evidence with it. A report has to
-- outlive what it is about, and `reported_user_id` keeps the account
-- actionable either way.
-- ---------------------------------------------------------------------------
create table if not exists public.content_reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references auth.users (id) on delete cascade,
  target_kind  text not null check (target_kind in ('match', 'comment')),
  target_id    uuid not null,
  reported_user_id uuid references auth.users (id) on delete set null,
  -- Match title or comment body as it read when reported.
  content_snapshot text,
  reason       text not null check (reason in ('abuse', 'sexual', 'violence', 'spam', 'other')),
  details      text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz
);
create index if not exists content_reports_target_idx
  on public.content_reports (target_kind, target_id);
create index if not exists content_reports_open_idx
  on public.content_reports (created_at) where resolved_at is null;

alter table public.content_reports enable row level security;

create policy "read own reports"
  on public.content_reports for select to authenticated
  using (reporter_id = auth.uid());
create policy "file own reports"
  on public.content_reports for insert to authenticated
  with check (reporter_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Blocked users' comments disappear.
--
-- Enforced in the read policy rather than in the query, so every caller —
-- web, iOS, and anything added later — gets the filtering for free.
-- ---------------------------------------------------------------------------
drop policy if exists "read comments of visible videos" on public.match_comments;
create policy "read comments of visible videos"
  on public.match_comments for select to authenticated
  using (public.can_view_video(video_id) and not public.is_blocked(author_id));

-- ---------------------------------------------------------------------------
-- get_feed, with blocked users filtered out.
--
-- Rebased on **0008's** definition, not 0007's — 0008 added the `in_library`
-- column that the feed's "add to profile" state reads, and dropping it here
-- would both fail to apply (`create or replace` cannot change a function's
-- return type) and, if forced through with a DROP, silently break the save
-- button on every feed card in both clients.
--
-- The only changes from 0008 are the two `is_blocked` guards: a match leaves
-- the feed if whoever shared it is blocked, or if its owner is. Own-library
-- rows (`shared_by is null`) are unaffected — blocking someone does not hide a
-- match you have already saved.
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
  in_library      boolean,
  feed_at         timestamptz
)
language sql security definer set search_path = public stable as $$
  with me as (select auth.uid() as uid),
  candidates as (
    select ms.video_id, ms.user_id as shared_by, ms.created_at as feed_at
    from public.match_shares ms
    join public.follows f on f.followee_id = ms.user_id and f.follower_id = (select uid from me)
    where not public.is_blocked(ms.user_id)
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
  where v.owner_id is null or not public.is_blocked(v.owner_id)
  order by d.feed_at desc
  limit p_limit;
$$;
grant execute on function public.get_feed(int) to authenticated;

-- ---------------------------------------------------------------------------
-- Blocking someone also severs the follow edges between you.
--
-- Without this the follow rows survive a block and quietly restore the feed
-- connection the moment the block is lifted, which is not what either party
-- asked for.
-- ---------------------------------------------------------------------------
create or replace function public.sever_follows_on_block()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.follows
  where (follower_id = new.blocker_id and followee_id = new.blocked_id)
     or (follower_id = new.blocked_id and followee_id = new.blocker_id);
  return new;
end;
$$;

drop trigger if exists user_blocks_sever_follows on public.user_blocks;
create trigger user_blocks_sever_follows
  after insert on public.user_blocks
  for each row execute function public.sever_follows_on_block();
