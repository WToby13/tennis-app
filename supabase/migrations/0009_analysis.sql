-- AI rally segmentation (TwelveLabs). Adds per-video analysis status/tracking
-- columns and a video_segments table holding the returned rallies.
-- Run in the Supabase SQL editor after 0008_feed_in_library.sql.

-- 1. Analysis status/tracking on the video itself. Written by the owner via the
--    normal videos UPDATE policy (owner-only), so no extra RPC is needed here.
alter table public.videos
  add column if not exists analysis_status text
    check (analysis_status in ('none','processing','ready','failed')) default 'none',
  add column if not exists analysis_task_id text,
  add column if not exists analysis_error text,
  add column if not exists analyzed_at timestamptz;

-- 2. The segments a match was broken into. `kind` lets us store multiple analysis
--    types later (rallies today); `metadata` holds the custom per-segment fields.
create table if not exists public.video_segments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references public.videos(id) on delete cascade,
  kind text not null default 'rally',
  idx int not null,
  start_s double precision,
  end_s double precision,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists video_segments_video_idx
  on public.video_segments (video_id, kind, idx);

alter table public.video_segments enable row level security;

-- Anyone who can see the match can see its segments. can_view_video (0007) is
-- SECURITY DEFINER, so this doesn't recurse through the videos policy.
drop policy if exists "view segments of visible videos" on public.video_segments;
create policy "view segments of visible videos"
  on public.video_segments for select
  to authenticated
  using (public.can_view_video(video_id));

-- 3. Write-back: replace a match's segments of one kind in a single definer call
--    (checks edit rights once, then delete + bulk insert), modelled on
--    set_participants (0006). Keeps writes off the general table policies.
create or replace function public.replace_video_segments(
  p_video_id uuid, p_kind text, p_segments jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_video(p_video_id) then
    raise exception 'not allowed to edit this video';
  end if;
  delete from public.video_segments where video_id = p_video_id and kind = p_kind;
  insert into public.video_segments (video_id, kind, idx, start_s, end_s, metadata)
  select p_video_id,
         p_kind,
         (elem ->> 'idx')::int,
         nullif(elem ->> 'startS', '')::double precision,
         nullif(elem ->> 'endS', '')::double precision,
         coalesce(elem -> 'metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) as elem;
end;
$$;
grant execute on function public.replace_video_segments(uuid, text, jsonb) to authenticated;
