-- Analysis proxy: a temporary, smaller re-encode of a match, created only to fit
-- TwelveLabs' input size limit and deleted as soon as the breakdown finishes.
-- Run in the Supabase SQL editor after 0010_analysis_players.sql.
--
-- Only a boolean is needed: the object's storage key is derived from the video id
-- (see lib/storage/types.ts `analysisProxyKey`), the same way thumbnails are.
-- The flag says "there are bytes to clean up", nothing more.
alter table public.videos
  add column if not exists has_analysis_proxy boolean not null default false;

-- Written by the owner through the existing videos UPDATE policy (owner-only),
-- so no new policy or RPC is required.
