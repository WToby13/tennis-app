-- ---------------------------------------------------------------------------
-- The content filter, at the last place it can be enforced.
--
-- Guideline 1.2's first precaution is "a method for filtering objectionable
-- content". `web/lib/moderation/filter.ts` does that for everything that
-- arrives through the Next API — comments, match titles, participant names —
-- which is both clients for all three.
--
-- Names are the exception. The iOS Edit-profile sheet writes the `profiles` row
-- straight through the Supabase client, the same way the web profile page does,
-- so no API route ever sees it and a filter in TypeScript cannot reach it. The
-- check has to live where the write lands.
--
-- The term list is therefore in two places, which is a real cost and worth
-- naming: the TypeScript list and this one have to be changed together. The
-- alternative — routing profile writes through the API purely to reach the
-- filter — buys one list at the price of a round trip and a new endpoint on a
-- path that has never needed one. The lists are small and change rarely, so the
-- duplication is the cheaper of the two.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Does this text contain something we refuse to store?
--
-- Mirrors the TypeScript in shape as well as content: fold case, undo the
-- obvious character substitutions, then two passes. The word-boundary pass is
-- safe for short terms (it is what stops "Scunthorpe"); the separator-stripped
-- pass catches "f.a.g.g.o.t" and only runs for terms specific enough that
-- appearing inside an ordinary word is not a thing that happens.
--
-- Patterns repeat each letter (`n+i+g+g+e+r+`) so stretched spellings match
-- without the text and the list having to be collapsed in step — collapsing
-- both would turn "coon" into "con" and start rejecting an innocent word.
-- ---------------------------------------------------------------------------
create or replace function public.contains_objectionable(p_text text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  folded     text;
  collapsed  text;
  pat        text;
  -- Matched with word boundaries. Short and substring-prone terms live here.
  boundary_pats text[] := array[
    'n+i+g+g+e+r+', 'n+i+g+g+a+', 'f+a+g+g+o+t+', 'f+a+g+', 't+r+a+n+n+y+',
    'k+i+k+e+', 's+p+i+c+', 'c+h+i+n+k+', 'w+e+t+b+a+c+k+', 'p+a+k+i+',
    'g+o+o+k+', 'c+o+o+n+', 'r+e+t+a+r+d+', 'r+e+t+a+r+d+e+d+',
    'p+o+r+n+', 'p+o+r+n+o+', 'b+l+o+w+j+o+b+', 'h+a+n+d+j+o+b+',
    'c+u+m+s+h+o+t+', 'd+i+l+d+o+', 'p+e+d+o+p+h+i+l+e+', 'p+a+e+d+o+p+h+i+l+e+',
    'r+a+p+e+', 'r+a+p+i+s+t+', 'i+n+c+e+s+t+', 'b+e+s+t+i+a+l+i+t+y+',
    'k+i+l+l+\s+y+o+u+r+s+e+l+f+', 'k+y+s+', 'l+y+n+c+h+',
    'c+u+n+t+', 'w+h+o+r+e+', 's+l+u+t+'
  ];
  -- Matched with every separator removed. Long and unambiguous only.
  strict_pats text[] := array[
    'n+i+g+g+e+r+', 'n+i+g+g+a+', 'f+a+g+g+o+t+', 't+r+a+n+n+y+', 'k+i+k+e+',
    'w+e+t+b+a+c+k+', 'r+e+t+a+r+d+', 'b+l+o+w+j+o+b+', 'h+a+n+d+j+o+b+',
    'c+u+m+s+h+o+t+', 'd+i+l+d+o+', 'p+e+d+o+p+h+i+l+e+', 'p+a+e+d+o+p+h+i+l+e+',
    'r+a+p+i+s+t+', 'i+n+c+e+s+t+', 'b+e+s+t+i+a+l+i+t+y+',
    'k+i+l+l+y+o+u+r+s+e+l+f+', 'w+h+o+r+e+', 's+l+u+t+'
  ];
begin
  if p_text is null or btrim(p_text) = '' then
    return false;
  end if;

  -- '0134578@$!|' -> 'oieastbasil', character for character.
  folded := translate(lower(p_text), '0134578@$!|', 'oieastbasil');
  collapsed := regexp_replace(folded, '[^a-z0-9]', '', 'g');

  foreach pat in array boundary_pats loop
    -- \y is a word boundary in Postgres' regex flavour.
    if folded ~ ('\y' || pat || '\y') then
      return true;
    end if;
  end loop;

  foreach pat in array strict_pats loop
    if collapsed ~ pat then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

comment on function public.contains_objectionable(text) is
  'Guideline 1.2 content filter for text written straight to the database. Kept in step with web/lib/moderation/filter.ts.';

-- ---------------------------------------------------------------------------
-- Refuse the write rather than cleaning it up afterwards.
--
-- An exception, not a silent rewrite: a name quietly replaced with something
-- else is worse than a name refused, because the person goes on believing it is
-- what everyone else sees.
-- ---------------------------------------------------------------------------
create or replace function public.reject_objectionable_profile()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.contains_objectionable(new.display_name)
     or public.contains_objectionable(new.first_name)
     or public.contains_objectionable(new.last_name) then
    raise exception 'That name contains language we don''t allow. Please choose another.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_content_filter on public.profiles;
create trigger profiles_content_filter
  before insert or update of display_name, first_name, last_name
  on public.profiles
  for each row
  execute function public.reject_objectionable_profile();

-- Participant names reach everyone a match is shared with, including people
-- with no account who open a share link. The API filters them too; this covers
-- the `set_participants` RPC being called directly.
create or replace function public.reject_objectionable_participant()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.contains_objectionable(new.display_name) then
    raise exception 'That name contains language we don''t allow. Please choose another.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists participants_content_filter on public.video_participants;
create trigger participants_content_filter
  before insert or update of display_name
  on public.video_participants
  for each row
  execute function public.reject_objectionable_participant();

-- Comments are filtered in the API for both clients, but the table is writable
-- by any authenticated session under RLS, so the floor belongs here too.
create or replace function public.reject_objectionable_comment()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if public.contains_objectionable(new.body) then
    raise exception 'That comment contains language we don''t allow. Please rephrase it.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists comments_content_filter on public.match_comments;
create trigger comments_content_filter
  before insert or update of body
  on public.match_comments
  for each row
  execute function public.reject_objectionable_comment();
