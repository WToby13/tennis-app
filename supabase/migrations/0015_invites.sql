-- Invitations: make "add someone to a match" one idea with one claim path.
-- Run in the Supabase SQL editor after 0014_moderation.sql.
--
-- What was broken before this:
--   1. set_participants took `userId` at face value and never looked an email up
--      against existing accounts — so inviting someone who was already on Ojo by
--      typing their address created a guest row that granted them nothing, ever.
--   2. The only claim path was handle_new_user matching lower(email) at signup, so
--      an invitee who joined with any other address (or via Google) was never
--      linked. The invite, not the address, should be the proof.
--   3. Nothing deduped: a guest row and a linked row for the same human coexisted,
--      which is how one person shows up twice on a match.
--   4. Claiming set user_id but left display_name as the email's local part, so an
--      invitee stayed "guillem.torner" forever after joining.

-- ---------------------------------------------------------------------------
-- 1. Invite tokens on the participant row
-- ---------------------------------------------------------------------------
alter table public.video_participants
  add column if not exists invite_token text,
  add column if not exists claimed_at   timestamptz;

create unique index if not exists video_participants_invite_token_idx
  on public.video_participants (invite_token) where invite_token is not null;

-- The token is a bearer capability: holding it makes you this participant. RLS is
-- row-level, and the select policy lets anyone who can see the match read its
-- participant rows — so on a public match a table-wide SELECT would hand every
-- signed-in user the pending invites. Withhold it with column grants instead:
-- clients read participants without it, editors get tokens from
-- participant_invites() below, and the definer functions here run as the owner so
-- they are unaffected.
--
-- NOTE: a new column on this table needs adding to the grant list, or it will be
-- invisible to clients.
revoke select on public.video_participants from anon, authenticated;
grant select (id, video_id, user_id, display_name, email, added_by, created_at, claimed_at)
  on public.video_participants to authenticated;

-- 122 bits of entropy, url-safe, no extension dependency beyond gen_random_uuid
-- (already relied on by this table's primary key).
create or replace function public.new_invite_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '');
$$;

-- ---------------------------------------------------------------------------
-- 2. Email → existing account
-- ---------------------------------------------------------------------------
-- Deliberately NOT granted to authenticated: a callable email→uuid lookup is an
-- account-enumeration oracle. It is only ever invoked from inside the definer
-- functions below, which run as the owner and so need no grant.
create or replace function public.user_id_for_email(p_email text)
returns uuid language sql security definer set search_path = public, auth stable as $$
  select u.id from auth.users u
   where p_email is not null and lower(u.email) = lower(p_email)
   order by u.created_at
   limit 1;
$$;
revoke all on function public.user_id_for_email(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Normalising an incoming participant list
-- ---------------------------------------------------------------------------
-- One place that decides who a list entry actually *is*: an email that belongs to
-- an account resolves to that account, a linked person is named by their profile
-- rather than by whatever the tagger typed, and the same human named two ways
-- collapses to one row. set_participants leans on this so the merge below is
-- purely about matching against what is already stored.
create or replace function public.normalized_participants(p_participants jsonb)
returns table (user_id uuid, display_name text, email text, ord bigint)
language sql stable security definer set search_path = public as $$
  with raw as (
    select
      t.ord,
      nullif(t.elem ->> 'userId', '')::uuid            as given_user_id,
      nullif(btrim(t.elem ->> 'displayName'), '')      as given_name,
      lower(nullif(btrim(t.elem ->> 'email'), ''))     as email
    from jsonb_array_elements(coalesce(p_participants, '[]'::jsonb))
         with ordinality as t(elem, ord)
  ),
  resolved as (
    select
      r.ord,
      coalesce(r.given_user_id, public.user_id_for_email(r.email)) as user_id,
      r.given_name,
      r.email
    from raw r
    where r.given_name is not null
  ),
  named as (
    select
      r.ord,
      r.user_id,
      coalesce(nullif(btrim(p.display_name), ''), r.given_name) as display_name,
      r.email
    from resolved r
    left join public.profiles p on p.id = r.user_id
  )
  -- Identity for dedupe: the account if we know it, else the address, else the
  -- name. Earliest occurrence wins so the order the tagger chose is kept.
  select distinct on (coalesce(n.user_id::text, 'e:' || n.email, 'n:' || lower(n.display_name)))
    n.user_id, n.display_name, n.email, n.ord
  from named n
  order by coalesce(n.user_id::text, 'e:' || n.email, 'n:' || lower(n.display_name)), n.ord;
$$;
revoke all on function public.normalized_participants(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. set_participants: merge rather than replace
-- ---------------------------------------------------------------------------
-- The old version deleted the whole list and re-inserted it, which threw away
-- invite tokens and created_at on every edit — re-saving a match would have
-- invalidated a pending invite link. This matches incoming entries against stored
-- rows (by account, then address, then name), updates those, removes the rest,
-- and only inserts genuinely new people.
create or replace function public.set_participants(p_video_id uuid, p_participants jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_video(p_video_id) then
    raise exception 'not allowed to edit this video';
  end if;

  -- Collapse rows that already describe the same person before matching anything:
  -- a guest row whose address has since become an account, sitting alongside that
  -- account's own row. Left in place, both would match the same incoming entry and
  -- the merge would try to give two rows the same user_id.
  delete from public.video_participants vp
   where vp.video_id = p_video_id
     and vp.user_id is null
     and vp.email is not null
     and exists (select 1 from public.video_participants o
                  where o.video_id = vp.video_id
                    and o.user_id is not null
                    and o.user_id = public.user_id_for_email(vp.email));

  -- Gone from the list.
  delete from public.video_participants vp
   where vp.video_id = p_video_id
     and not exists (
       select 1 from public.normalized_participants(p_participants) n
        where (vp.user_id is not null and n.user_id is not null and vp.user_id = n.user_id)
           or (vp.email   is not null and n.email   is not null and lower(vp.email) = n.email)
           or (vp.user_id is null and n.user_id is null
               and vp.email is null and n.email is null
               and lower(btrim(vp.display_name)) = lower(btrim(n.display_name)))
     );

  -- Still there: refresh the name, and upgrade a guest whose address turned out to
  -- belong to an account. The update trigger grants them library access.
  update public.video_participants vp
     set user_id      = coalesce(n.user_id, vp.user_id),
         display_name = n.display_name,
         email        = coalesce(n.email, vp.email),
         claimed_at   = case
                          when vp.user_id is null and n.user_id is not null then now()
                          else vp.claimed_at
                        end
    from public.normalized_participants(p_participants) n
   where vp.video_id = p_video_id
     and ((vp.user_id is not null and n.user_id is not null and vp.user_id = n.user_id)
       or (vp.email   is not null and n.email   is not null and lower(vp.email) = n.email)
       or (vp.user_id is null and n.user_id is null
           and vp.email is null and n.email is null
           and lower(btrim(vp.display_name)) = lower(btrim(n.display_name))));

  -- Genuinely new. Email guests get their invite token here, so the routes always
  -- have a link to send (or to fall back on when mail fails).
  insert into public.video_participants (video_id, user_id, display_name, email, added_by, invite_token)
  select p_video_id, n.user_id, n.display_name, n.email, auth.uid(),
         case when n.user_id is null and n.email is not null
              then public.new_invite_token() end
    from public.normalized_participants(p_participants) n
   where not exists (
     select 1 from public.video_participants vp
      where vp.video_id = p_video_id
        and ((vp.user_id is not null and n.user_id is not null and vp.user_id = n.user_id)
          or (vp.email   is not null and n.email   is not null and lower(vp.email) = n.email)
          or (vp.user_id is null and n.user_id is null
              and vp.email is null and n.email is null
              and lower(btrim(vp.display_name)) = lower(btrim(n.display_name))))
   );
end;
$$;
grant execute on function public.set_participants(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Library access when a row is *linked*, not just inserted
-- ---------------------------------------------------------------------------
-- 0005 only granted access on insert. Now that a guest row can be upgraded in
-- place (by set_participants or by claiming an invite), the update needs the same
-- grant — and has to hand back the access the previous occupant got from the tag.
create or replace function public.relink_participant_library()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.user_id is not null then
    delete from public.library_items
     where user_id = old.user_id and video_id = old.video_id and added_via = 'participant';
  end if;
  if new.user_id is not null then
    insert into public.library_items (user_id, video_id, added_via)
    values (new.user_id, new.video_id, 'participant')
    on conflict do nothing; -- keep a stronger existing membership (upload/share)
  end if;
  return new;
end;
$$;

drop trigger if exists on_participant_relinked on public.video_participants;
create trigger on_participant_relinked
  after update of user_id on public.video_participants
  for each row when (new.user_id is distinct from old.user_id)
  execute function public.relink_participant_library();

-- ---------------------------------------------------------------------------
-- 6. Claiming an invite
-- ---------------------------------------------------------------------------
-- The token is the proof. Whatever address or provider the invitee signed up
-- with, holding the link makes them this participant — which is the fix for
-- "he created an account and it still wasn't connected".
create or replace function public.claim_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  vp      public.video_participants;
  me      uuid := auth.uid();
  my_name text;
begin
  if me is null then raise exception 'not signed in'; end if;

  select * into vp from public.video_participants where invite_token = p_token;
  if not found then raise exception 'invalid invite'; end if;

  -- Someone else already took it. (Claiming twice as the same person is fine —
  -- people re-open emails.)
  if vp.user_id is not null and vp.user_id <> me then
    raise exception 'invite already claimed';
  end if;

  select nullif(btrim(p.display_name), '') into my_name
    from public.profiles p where p.id = me;

  if exists (select 1 from public.video_participants o
              where o.video_id = vp.video_id and o.user_id = me and o.id <> vp.id) then
    -- Already on this match under my own row — the invite was a placeholder for
    -- me, so retire it rather than leaving two of me on the match.
    delete from public.video_participants where id = vp.id;
  else
    update public.video_participants
       set user_id      = me,
           display_name = coalesce(my_name, display_name),
           claimed_at   = coalesce(claimed_at, now())
     where id = vp.id;
  end if;

  insert into public.library_items (user_id, video_id, added_via)
  values (me, vp.video_id, 'participant')
  on conflict do nothing;

  return vp.video_id;
end;
$$;
grant execute on function public.claim_invite(text) to authenticated;

-- What an invite link should show before you sign up: enough to recognise it, and
-- nothing that isn't already implied by holding the token. Callable signed-out.
create or replace function public.invite_preview(p_token text)
returns table (video_id uuid, match_title text, invited_name text, invited_email text,
               inviter_name text, claimed boolean)
language sql security definer set search_path = public stable as $$
  select v.id, v.title, vp.display_name, vp.email,
         inviter.display_name, vp.user_id is not null
    from public.video_participants vp
    join public.videos v on v.id = vp.video_id and v.deleted_at is null
    left join public.profiles inviter on inviter.id = vp.added_by
   where vp.invite_token = p_token;
$$;
grant execute on function public.invite_preview(text) to authenticated, anon;

-- Editor-only view of a match's invites, with their tokens — the one way the
-- token reaches a client. Backfills a token for any pending invite that predates
-- this migration, so old invites become linkable instead of stranded.
create or replace function public.participant_invites(p_video_id uuid)
returns table (id uuid, display_name text, email text, invite_token text, claimed boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_video(p_video_id) then
    raise exception 'not allowed to edit this video';
  end if;

  update public.video_participants vp
     set invite_token = public.new_invite_token()
   where vp.video_id = p_video_id
     and vp.user_id is null and vp.email is not null and vp.invite_token is null;

  return query
    select vp.id, vp.display_name, vp.email, vp.invite_token, vp.user_id is not null
      from public.video_participants vp
     where vp.video_id = p_video_id and vp.email is not null
     order by vp.created_at;
end;
$$;
grant execute on function public.participant_invites(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Signup still claims by address — as a convenience, not the only route
-- ---------------------------------------------------------------------------
-- Additions over 0005: drop the placeholder instead of duplicating when they are
-- already on the match, and take the display name from the profile they just
-- created so nobody stays named after their email prefix.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  fn   text := coalesce(new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'given_name');
  ln   text := coalesce(new.raw_user_meta_data ->> 'last_name',  new.raw_user_meta_data ->> 'family_name');
  name text;
begin
  name := coalesce(
    nullif(trim(concat_ws(' ', fn, ln)), ''),
    new.raw_user_meta_data ->> 'display_name',
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(new.email, '@', 1)
  );

  insert into public.profiles (id, first_name, last_name, handedness, display_name)
  values (new.id, fn, ln, new.raw_user_meta_data ->> 'handedness', name)
  on conflict (id) do nothing;

  -- A pending invite for a match they are somehow already on is a duplicate.
  delete from public.video_participants vp
   where vp.user_id is null
     and lower(vp.email) = lower(new.email)
     and exists (select 1 from public.video_participants o
                  where o.video_id = vp.video_id and o.user_id = new.id);

  update public.video_participants vp
     set user_id      = new.id,
         display_name = coalesce(name, vp.display_name),
         claimed_at   = now()
   where vp.user_id is null and lower(vp.email) = lower(new.email);

  insert into public.library_items (user_id, video_id, added_via)
  select new.id, vp.video_id, 'participant'
    from public.video_participants vp
   where vp.user_id = new.id
  on conflict do nothing;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Repair what the old code left behind
-- ---------------------------------------------------------------------------
-- Guest rows whose address already belongs to an account: link them and give them
-- the access the tag always meant to grant. (This is the case that silently did
-- nothing before — including, most likely, some of the rows on your own matches.)
update public.video_participants vp
   set user_id    = public.user_id_for_email(vp.email),
       claimed_at = now()
 where vp.user_id is null
   and vp.email is not null
   and public.user_id_for_email(vp.email) is not null
   -- unless that account is already tagged on the match under its own row
   and not exists (select 1 from public.video_participants o
                    where o.video_id = vp.video_id
                      and o.user_id = public.user_id_for_email(vp.email));

-- ...and drop the placeholders that duplicated an account already on the match.
delete from public.video_participants vp
 where vp.user_id is null
   and vp.email is not null
   and exists (select 1 from public.video_participants o
                where o.video_id = vp.video_id
                  and o.user_id = public.user_id_for_email(vp.email));

-- Anyone linked but still wearing an email-prefix name gets their real one.
update public.video_participants vp
   set display_name = p.display_name
  from public.profiles p
 where p.id = vp.user_id
   and nullif(btrim(p.display_name), '') is not null
   and lower(btrim(vp.display_name)) <> lower(btrim(p.display_name));

-- Backfill library access for every linked participant (the pre-0014 update path
-- had no trigger, so some grants were never made).
insert into public.library_items (user_id, video_id, added_via)
select vp.user_id, vp.video_id, 'participant'
  from public.video_participants vp
 where vp.user_id is not null
on conflict do nothing;

-- The same address tagged twice on one match — nothing stopped it before.
delete from public.video_participants vp
 where vp.user_id is null
   and vp.email is not null
   and exists (select 1 from public.video_participants o
                where o.video_id = vp.video_id
                  and o.user_id is null
                  and lower(o.email) = lower(vp.email)
                  and (o.created_at, o.id) < (vp.created_at, vp.id));

-- ...and now it can't. set_participants merges rather than replaces, so this is
-- belt and braces against a client posting the same guest twice.
create unique index if not exists video_participants_video_email_idx
  on public.video_participants (video_id, lower(email)) where user_id is null and email is not null;

-- Give every still-pending email invite a token, so existing invites are
-- linkable the moment this deploys.
update public.video_participants
   set invite_token = public.new_invite_token()
 where user_id is null and email is not null and invite_token is null;
