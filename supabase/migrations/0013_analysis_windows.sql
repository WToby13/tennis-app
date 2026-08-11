-- Windowed analysis.
--
-- A long match is analysed as several short overlapping windows rather than one
-- call, because Pegasus stops describing what it sees past roughly a few dozen
-- segments (see web/lib/twelvelabs/windows.ts for the measurements). Each window
-- is its own TwelveLabs task, so a run in flight now has N task ids instead of
-- one, and the poll can only finalize when every window is ready.
--
-- analysis_task_id is kept and still carries the single-task case, so short
-- matches and any run started before this migration keep working untouched.

alter table public.videos
  add column if not exists analysis_windows jsonb;

comment on column public.videos.analysis_windows is
  'Windowed analysis state: [{"startS":int,"endS":int,"taskId":text}]. Null when the match was analysed in a single call (see analysis_task_id).';
