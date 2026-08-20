-- Enough of Supabase to run the real migrations against: the roles, the auth
-- schema, auth.uid() driven by a session GUC, and the blanket public-schema
-- grants Supabase hands to anon/authenticated.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema if not exists auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- The signed-in user for the current session, set with `set local request.uid`.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.uid', true), '')::uuid;
$$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- Supabase's default: every public table is granted to the API roles, which is
-- exactly why 0014 has to use column grants to hide invite_token.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
