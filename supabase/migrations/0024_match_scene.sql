-- The match as a 3D scene (ml/ojo_replay/scene.py): every rally's ball flights
-- and both players in court coordinates, and the court's own surface as a
-- texture. A few MB a match, growing with its length, so the scene itself is
-- in storage (scenes/<video id>.json, beside the thumbnails) and this records
-- that it's there and which version of the format it is. The worker sets it
-- after uploading (/api/worker/videos/:id/scene); the watch page's 3D view
-- reads it through /api/videos/:id/match-scene and the existing select policy.
-- Run in the Supabase SQL editor after 0023_match_analyses.sql.
alter table public.match_analyses add column if not exists scene_version integer;
