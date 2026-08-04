-- Slice 1: owner-private videos + revocable share links + "Add to my account".
-- Also lays the social-feed foundation (a `visibility` column, public read path).
-- Run in the Supabase SQL editor after 0001_init.sql.

-- ---------------------------------------------------------------------------
-- videos: soft-delete + visibility.
--   deleted_at  → soft delete (row kept for FK/audit; bytes purged separately).
--   visibility  → 'private' today; 'public' is the future feed read-path, and
--                 the access checks below already honour it.
-- ---------------------------------------------------------------------------
alter table public.videos add column if not exists deleted_at timestamptz;

alter table public.videos add column if not exists visibility text not null default 'private'
  check (visibility in ('private', 'unlisted', 'public'));

-- ---------------------------------------------------------------------------
-- library_items: which videos are in a given user's library.
--   The uploader is auto-added (trigger below); "Add to my account" inserts a row.
--   This is also the mechanism a future club/booking would use to grant players.
-- ---------------------------------------------------------------------------
create table if not exists public.library_items (
  user_id   uuid not null references auth.users (id) on delete cascade,
  video_id  uuid not null references public.videos (id) on delete cascade,
  added_via text not null default 'upload' check (added_via in ('upload', 'share')),
  added_at  timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index if not exists library_items_user_idx
  on public.library_items (user_id, added_at desc);

alter table public.library_items enable row level security;

-- You only see and manage your own library rows.
create policy "own library rows"
  on public.library_items for all
  to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- share_links: a revocable bearer capability carried in the /watch URL (?s=token).
--   can_add    → future: view-only vs add-to-account links.
--   expires_at → null means never; revoked_at non-null means dead.
-- ---------------------------------------------------------------------------
create table if not exists public.share_links (
  token      text primary key,
  video_id   uuid not null references public.videos (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  can_add    boolean not null default true,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists share_links_video_idx on public.share_links (video_id);

alter table public.share_links enable row level security;

-- Only the creator lists/revokes their links. Token *resolution* is via the
-- security-definer RPCs below, so viewers never need to read this table directly.
create policy "own share links"
  on public.share_links for all
  to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- videos RLS: replace the permissive "any authed reads all" policy with
-- owner OR in-my-library OR public — and never show soft-deleted rows.
-- ---------------------------------------------------------------------------
drop policy if exists "videos readable by authenticated" on public.videos;

create policy "videos readable by owner, library or public"
  on public.videos for select
  to authenticated using (
    deleted_at is null and (
      owner_id = auth.uid()
      or visibility = 'public'
      or exists (
        select 1 from public.library_items li
        where li.video_id = videos.id and li.user_id = auth.uid()
      )
    )
  );
-- insert / update / delete policies from 0001 stay owner-only (soft-delete is an update).

-- ---------------------------------------------------------------------------
-- Auto-add the uploader to their own library on video insert.
-- ---------------------------------------------------------------------------
create or replace function public.add_owner_to_library()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.library_items (user_id, video_id, added_via)
  values (new.owner_id, new.id, 'upload')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_video_created on public.videos;
create trigger on_video_created
  after insert on public.videos
  for each row when (new.owner_id is not null)
  execute function public.add_owner_to_library();

-- Backfill: every existing video goes into its owner's library.
insert into public.library_items (user_id, video_id, added_via)
select owner_id, id, 'upload' from public.videos where owner_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Share operations as security-definer RPCs. RLS can't see the URL token, so
-- these encapsulate the token check while the tables stay strictly own-only.
-- ---------------------------------------------------------------------------

-- Resolve a share token → the video (bypasses the strict SELECT policy safely).
create or replace function public.get_shared_video(p_token text)
returns public.videos language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  select vi.* into v
  from public.share_links s
  join public.videos vi on vi.id = s.video_id
  where s.token = p_token
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and vi.deleted_at is null;
  if not found then
    raise exception 'invalid or expired share link' using errcode = 'no_data_found';
  end if;
  return v;
end;
$$;

-- Add-to-my-account via a valid, add-enabled token (inserts a library row for the caller).
create or replace function public.add_shared_video(p_token text)
returns public.videos language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  select vi.* into v
  from public.share_links s
  join public.videos vi on vi.id = s.video_id
  where s.token = p_token
    and s.can_add
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and vi.deleted_at is null;
  if not found then
    raise exception 'invalid or expired share link' using errcode = 'no_data_found';
  end if;
  insert into public.library_items (user_id, video_id, added_via)
  values (auth.uid(), v.id, 'share')
  on conflict do nothing;
  return v;
end;
$$;

-- Let signed-in users call the RPCs (they self-authorize via the token inside).
grant execute on function public.get_shared_video(text) to authenticated;
grant execute on function public.add_shared_video(text) to authenticated;
