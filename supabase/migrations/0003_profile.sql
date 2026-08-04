-- Profile fields for account creation: name + playing hand.
-- Run in the Supabase SQL editor after 0002_sharing.sql.

alter table public.profiles add column if not exists first_name text;
alter table public.profiles add column if not exists last_name  text;
alter table public.profiles add column if not exists handedness text
  check (handedness in ('left', 'right'));

-- Populate the profile from sign-up metadata (options.data on auth.signUp).
-- Falls back to the email prefix for display_name so older/social signups still work.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fn text := new.raw_user_meta_data ->> 'first_name';
  ln text := new.raw_user_meta_data ->> 'last_name';
begin
  insert into public.profiles (id, first_name, last_name, handedness, display_name)
  values (
    new.id,
    fn,
    ln,
    new.raw_user_meta_data ->> 'handedness',
    coalesce(
      nullif(trim(concat_ws(' ', fn, ln)), ''),
      new.raw_user_meta_data ->> 'display_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
