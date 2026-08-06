-- Human names for the two players in an AI rally breakdown. A display-only
-- relabel of the model's player_1 (near at the start) / player_2 (far at start);
-- does not affect analysis. Owner-editable via the existing owner-only videos
-- UPDATE policy, so no new policy is needed.
-- Run in the Supabase SQL editor after 0009_analysis.sql.
--
-- Shape: { "player_1": "Alex", "player_2": "Sam" }  (either key optional)
alter table public.videos add column if not exists analysis_players jsonb;
