-- People search that respects blocking.
-- Run in the Supabase SQL editor after 0015_invites.sql.
--
-- Why this needs to be a function rather than a filtered select.
--
-- `/api/users` used to be reachable only from the participant picker — you had
-- already played the person you were tagging. It is now behind a magnifying
-- glass on the Home screen, which makes it a browsable directory of everyone on
-- Ojo, and that changes what it owes a blocked user.
--
-- Filtering it client-side can only ever be half a fix. `user_blocks` RLS
-- exposes rows where you are the *blocker* and deliberately not rows where you
-- are the blocked party, because "who blocked me" is precisely what a block
-- withholds. So a query built from what the client can read hides the people
-- you blocked, and still lets someone who blocked you type your name and open
-- your profile — while the feed and the comment list, which both go through
-- `is_blocked()`, hide them in both directions. Search would have been the one
-- surface where a block leaked.
--
-- SECURITY DEFINER lets the symmetric `is_blocked()` do the filtering inside
-- the database, without granting the caller any wider view of user_blocks.

create or replace function public.search_users(p_query text, p_limit int default 10)
returns table (id uuid, display_name text)
language sql security definer set search_path = public stable as $$
  with q as (
    -- Escape the LIKE metacharacters rather than stripping them: a name
    -- containing an underscore should match itself, not act as a wildcard.
    select '%' || replace(replace(btrim(p_query), '\', '\\'), '%', '\%') || '%' as pattern
  )
  select p.id,
         coalesce(
           nullif(btrim(coalesce(p.display_name, '')), ''),
           nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
           'Ojo player'
         ) as display_name
    from public.profiles p, q
   where length(btrim(p_query)) >= 2
     -- Never list the searcher back to themselves.
     and p.id <> auth.uid()
     and (p.display_name ilike q.pattern escape '\'
       or p.first_name   ilike q.pattern escape '\'
       or p.last_name    ilike q.pattern escape '\')
     and not public.is_blocked(p.id)
   order by display_name
   limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

grant execute on function public.search_users(text, int) to authenticated;
