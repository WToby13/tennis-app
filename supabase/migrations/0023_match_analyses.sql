-- Our own match analysis (ml/ pipeline): every shot with its speed and bounce,
-- the rallies, which player is which, who served and the games. Written by the
-- analysis worker through /api/worker/videos/:id/analysis (service role), read
-- wherever the match can be seen.
-- Run in the Supabase SQL editor after 0022_court_calibration.sql.
--
-- One row per match, replaced on every run; `pipeline_version` says which
-- version of the models and fitting produced it, so stale rows can be found and
-- re-run. `data` is MatchStats in web/lib/matchStats.ts. Kept out of `videos`
-- so listing matches doesn't drag a few hundred shots along per row.
create table if not exists public.match_analyses (
  video_id uuid primary key references public.videos(id) on delete cascade,
  pipeline_version text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.match_analyses enable row level security;

-- Anyone who can see the match can see its analysis (can_view_video, 0007, is
-- SECURITY DEFINER, so this doesn't recurse through the videos policy). No
-- write policies: only the service role writes, and it bypasses RLS.
drop policy if exists "view analysis of visible videos" on public.match_analyses;
create policy "view analysis of visible videos"
  on public.match_analyses for select
  to authenticated
  using (public.can_view_video(video_id));
