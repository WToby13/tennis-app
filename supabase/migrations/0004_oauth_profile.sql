-- Make profile creation work for OAuth (Google) sign-ups too.
-- Google puts the name under given_name/family_name/name/full_name in the user
-- metadata — not our first_name/last_name — so fall back to those.
-- Playing hand can't come from Google; OAuth users set it on first visit to /profile.
-- Run in the Supabase SQL editor after 0003_profile.sql.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fn text := coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'given_name');
  ln text := coalesce(new.raw_user_meta_data ->> 'last_name',  new.raw_user_meta_data ->> 'family_name');
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
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
