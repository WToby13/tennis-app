-- Participants ("who played"). A participant is either a linked Ojo user or a
-- guest name. Tagging a registered user drops the match into their library/feed
-- (via a 'participant' library_items row), delivering "share with who you played".
-- Run in the Supabase SQL editor after 0004_oauth_profile.sql.

-- ---------------------------------------------------------------------------
create table if not exists public.video_participants (
  id           uuid primary key default gen_random_uuid(),
  video_id     uuid not null references public.videos (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null, -- null = guest / not yet joined
  display_name text not null,
  email        text,  -- optional: invite a guest by email; claimed on signup
  added_by     uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists video_participants_email_idx on public.video_participants (lower(email));

-- One row per linked user per video (guests are unconstrained).
create unique index if not exists video_participants_video_user_idx
  on public.video_participants (video_id, user_id) where user_id is not null;
create index if not exists video_participants_video_idx on public.video_participants (video_id);
create index if not exists video_participants_user_idx on public.video_participants (user_id);

-- Allow a 'participant' source on library membership.
alter table public.library_items drop constraint if exists library_items_added_via_check;
alter table public.library_items
  add constraint library_items_added_via_check
  check (added_via in ('upload', 'share', 'participant'));

alter table public.video_participants enable row level security;

-- Read participants of any video you can see (the videos RLS is applied inside
-- this subquery; it references library_items only, so there is no policy cycle).
create policy "read participants of visible videos"
  on public.video_participants for select
  to authenticated using (
    exists (select 1 from public.videos v where v.id = video_participants.video_id)
  );

-- Only the video's owner adds/edits/removes participants.
create policy "owner manages participants"
  on public.video_participants for all
  to authenticated using (
    exists (select 1 from public.videos v where v.id = video_participants.video_id and v.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.videos v where v.id = video_participants.video_id and v.owner_id = auth.uid())
  );

-- Tagging a registered user grants them library access (so the match shows in
-- their library + home feed). Guests (null user_id) grant nothing.
create or replace function public.add_participant_to_library()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null then
    insert into public.library_items (user_id, video_id, added_via)
    values (new.user_id, new.video_id, 'participant')
    on conflict do nothing; -- keep any stronger existing membership (upload/share)
  end if;
  return new;
end;
$$;

drop trigger if exists on_participant_added on public.video_participants;
create trigger on_participant_added
  after insert on public.video_participants
  for each row execute function public.add_participant_to_library();

-- Removing a tag pulls the match back out of their feed — but only the access
-- that came *from* the tag, never a membership they created themselves.
create or replace function public.remove_participant_from_library()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.user_id is not null then
    delete from public.library_items
     where user_id = old.user_id and video_id = old.video_id and added_via = 'participant';
  end if;
  return old;
end;
$$;

drop trigger if exists on_participant_removed on public.video_participants;
create trigger on_participant_removed
  after delete on public.video_participants
  for each row execute function public.remove_participant_from_library();

-- ---------------------------------------------------------------------------
-- On signup, claim any participant invites addressed to this email: link them to
-- the new account and grant library access, so matches you were tagged in are
-- waiting for you. Extends handle_new_user (which also creates the profile).
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fn text := coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'given_name');
  ln text := coalesce(new.raw_user_meta_data ->> 'last_name',  new.raw_user_meta_data ->> 'family_name');
begin
  insert into public.profiles (id, first_name, last_name, handedness, display_name)
  values (
    new.id, fn, ln,
    new.raw_user_meta_data ->> 'handedness',
    coalesce(
      nullif(trim(concat_ws(' ', fn, ln)), ''),
      new.raw_user_meta_data ->> 'display_name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;

  -- Link pending email invites to this new account…
  update public.video_participants
     set user_id = new.id
   where user_id is null and lower(email) = lower(new.email);

  -- …and grant library access for the matches they were tagged in.
  insert into public.library_items (user_id, video_id, added_via)
  select new.id, video_id, 'participant' from public.video_participants
   where user_id = new.id
  on conflict do nothing;

  return new;
end;
$$;
