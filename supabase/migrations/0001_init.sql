-- Tennis app schema: profiles + videos, with row-level security.
-- Run this in the Supabase SQL editor (or via `supabase db push`).

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, auto-created on signup.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Everyone signed in can see profiles (to show who recorded a match).
create policy "profiles readable by authenticated"
  on public.profiles for select
  to authenticated using (true);

create policy "users manage own profile"
  on public.profiles for all
  to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Auto-create a profile whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- videos: metadata for each recording. Bytes live in S3; this is the index.
-- ---------------------------------------------------------------------------
create table if not exists public.videos (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  title           text not null,
  key             text not null,
  upload_id       text,
  content_type    text not null,
  size_bytes      bigint not null,
  part_size_bytes integer not null,
  duration_s      double precision,
  status          text not null default 'uploading'
                    check (status in ('uploading', 'processing', 'ready', 'failed')),
  recorded_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists videos_owner_idx on public.videos (owner_id);
create index if not exists videos_created_idx on public.videos (created_at desc);

alter table public.videos enable row level security;

-- MVP sharing model: any signed-in user (you + friends) can watch any match.
create policy "videos readable by authenticated"
  on public.videos for select
  to authenticated using (true);

-- But you can only create / change / delete your own recordings.
create policy "users insert own videos"
  on public.videos for insert
  to authenticated with check (owner_id = auth.uid());

create policy "users update own videos"
  on public.videos for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "users delete own videos"
  on public.videos for delete
  to authenticated using (owner_id = auth.uid());
