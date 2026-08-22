-- In-app notifications for comment mentions and thread replies.
-- Run in the Supabase SQL editor after 0016_search_users.sql.
--
-- Two things can put a row in someone's inbox, and they are deliberately the
-- only two:
--
--   'mention' — the comment names them with an @tag.
--   'reply'   — they are already part of that match's conversation (they have
--               commented on it, or they own the match) and someone else has
--               added to it.
--
-- A mention written by someone who is *in* the match also grants the tagged
-- player access to it (see notify_on_comment). A mention by anyone else does
-- not, and reaches them only if they could already open the match.
--
-- Comments are flat, so "the thread" is the match. That is also how both
-- clients render them, so the notification matches what the person sees when
-- they arrive.
--
-- The fan-out is a trigger rather than API code on purpose: iOS and web both
-- post comments through the same route today, but a comment written any other
-- way (a backfill, the SQL editor, a future route) still notifies the right
-- people, and no part of the app needs the service-role key to write into
-- somebody else's inbox.

-- ---------------------------------------------------------------------------
-- can_user_view_video: can_view_video for somebody other than the caller.
--
-- can_view_video is bound to auth.uid(), which is exactly right when it is
-- guarding the caller's own reads. The notification fan-out asks the opposite
-- question — "may *this recipient* open the match I am about to tell them
-- about" — so it needs the same rules with the user passed in. Kept as a
-- separate function rather than a rewrite so the existing policies that call
-- can_view_video are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.can_user_view_video(p_user uuid, p_video_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.videos v
    where v.id = p_video_id and v.deleted_at is null and (
      v.owner_id = p_user
      or v.visibility = 'public'
      or exists (select 1 from public.library_items li
                 where li.video_id = v.id and li.user_id = p_user)
      or exists (select 1 from public.match_shares ms
                 join public.follows f on f.followee_id = ms.user_id
                 where ms.video_id = v.id and f.follower_id = p_user)
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- can_user_edit_video: can_edit_video for somebody other than the caller.
--
-- Same reasoning as can_user_view_video above. This one answers "is this person
-- in the match" — owner or tagged participant — which is what decides whether
-- their @tag is allowed to hand out access below.
-- ---------------------------------------------------------------------------
create or replace function public.can_user_edit_video(p_user uuid, p_video_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.videos v
                 where v.id = p_video_id and v.owner_id = p_user)
      or exists (select 1 from public.video_participants vp
                 where vp.video_id = p_video_id and vp.user_id = p_user);
$$;

-- ---------------------------------------------------------------------------
-- notifications
--
-- No INSERT policy, by design. The only thing that writes here is the
-- SECURITY DEFINER trigger below; a client cannot put a row in anybody's inbox,
-- including its own. Read/update/delete are limited to the recipient, so
-- marking as read and clearing are ordinary authenticated calls.
-- ---------------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  -- Who it is for.
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- Who caused it. Nulled rather than cascaded: a deleted account should not
  -- take the recipient's history with it.
  actor_id   uuid references auth.users (id) on delete set null,
  kind       text not null check (kind in ('mention', 'reply')),
  video_id   uuid not null references public.videos (id) on delete cascade,
  comment_id uuid references public.match_comments (id) on delete cascade,
  -- A snapshot of the comment, so the inbox reads without a second fetch.
  body       text,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (user_id) where read_at is null;
-- One row per person per comment; a re-run of the fan-out cannot double up.
create unique index if not exists notifications_once_idx
  on public.notifications (user_id, comment_id) where comment_id is not null;

alter table public.notifications enable row level security;

-- Dropped first so the whole migration can be re-run. Everything else here is
-- already `if not exists` / `or replace`; a bare `create policy` was the one
-- statement that would fail on a second pass, which is exactly the pass you make
-- when the first one did not obviously take.
drop policy if exists "read own notifications" on public.notifications;
create policy "read own notifications"
  on public.notifications for select to authenticated
  using (user_id = auth.uid());
drop policy if exists "update own notifications" on public.notifications;
create policy "update own notifications"
  on public.notifications for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
drop policy if exists "delete own notifications" on public.notifications;
create policy "delete own notifications"
  on public.notifications for delete to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- search_followed_users: the @ picker's typeahead.
--
-- search_users (0016) is the directory — everyone on Ojo — which is right for
-- finding somebody to follow, and wrong for deciding who you may tag. Same
-- shape, same block filtering, narrowed to people the caller follows.
-- ---------------------------------------------------------------------------
create or replace function public.search_followed_users(p_query text, p_limit int default 10)
returns table (id uuid, display_name text)
language sql security definer set search_path = public stable as $$
  with q as (
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
     and p.id <> auth.uid()
     and exists (select 1 from public.follows f
                 where f.follower_id = auth.uid() and f.followee_id = p.id)
     and (p.display_name ilike q.pattern escape '\'
       or p.first_name   ilike q.pattern escape '\'
       or p.last_name    ilike q.pattern escape '\')
     and not public.is_blocked(p.id)
   order by display_name
   limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

-- ---------------------------------------------------------------------------
-- notify_on_comment: fan a new comment out to the people it concerns.
--
-- Mentions are stored in the comment body as `@[Display Name](uuid)` — the
-- clients render the display half and post the markup. Storing the id inline
-- rather than matching names later is what makes this unambiguous: two players
-- called "Sam" tag differently, and renaming yourself does not silently
-- re-point an old mention at someone else.
--
-- The uuid group is matched in full canonical form so the ::uuid cast can never
-- raise. It matters more than it looks: this trigger runs inside the comment's
-- own transaction, so an exception here would fail the comment itself.
-- ---------------------------------------------------------------------------
create or replace function public.notify_on_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mentions uuid[];
  v_owner    uuid;
begin
  select coalesce(array_agg(distinct (m[1])::uuid), '{}'::uuid[])
    into v_mentions
    from regexp_matches(
           new.body,
           '@\[[^\]]{1,80}\]\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)',
           'g'
         ) as m;

  select v.owner_id into v_owner from public.videos v where v.id = new.video_id;

  -- An @tag from someone who is in the match puts it in the tagged player's
  -- library, which is what makes it visible to them.
  --
  -- Without this the feature reads as broken: the picker searches everyone on
  -- Ojo, so you can tag anybody, and anybody who does not already follow you
  -- silently hears nothing. Tagging a participant already grants library access
  -- (see web/lib/participants.ts), so this is the same bargain by the same
  -- people — only the owner and the players in a match can widen who sees it,
  -- and only to someone they have deliberately named.
  --
  -- A tag from anyone else grants nothing, and the visibility check below then
  -- drops them: a comment is not a way to leak someone else's private match.
  if public.can_user_edit_video(new.author_id, new.video_id) then
    insert into public.library_items (user_id, video_id, added_via)
    select m.user_id, new.video_id, 'share'
      from unnest(v_mentions) as m(user_id)
     where m.user_id <> new.author_id
       and exists (select 1 from public.profiles p where p.id = m.user_id)
       -- You can only tag someone you follow. Enforced here and not only in the
       -- pickers, because with the grant above a tag is now a way to widen who
       -- can see a private match — and a rule that only exists in the client is
       -- not a rule, it is a default.
       and exists (select 1 from public.follows f
                   where f.follower_id = new.author_id and f.followee_id = m.user_id)
       and not exists (
         select 1 from public.user_blocks b
         where (b.blocker_id = m.user_id and b.blocked_id = new.author_id)
            or (b.blocker_id = new.author_id and b.blocked_id = m.user_id)
       )
    on conflict do nothing;
  end if;

  insert into public.notifications (user_id, actor_id, kind, video_id, comment_id, body)
  select r.user_id,
         new.author_id,
         -- Being named beats being in the thread: if both apply it is a mention.
         case when r.user_id = any (v_mentions) then 'mention' else 'reply' end,
         new.video_id,
         new.id,
         left(new.body, 500)
    from (
      select unnest(v_mentions) as user_id
      union
      select c.author_id from public.match_comments c where c.video_id = new.video_id
      union
      select v_owner
    ) r
   where r.user_id is not null
     -- Never notify yourself about your own comment.
     and r.user_id <> new.author_id
     -- Only real accounts.
     and exists (select 1 from public.profiles p where p.id = r.user_id)
     -- A block silences the notification in both directions, the same way it
     -- hides the comment itself.
     and not exists (
       select 1 from public.user_blocks b
       where (b.blocker_id = r.user_id and b.blocked_id = new.author_id)
          or (b.blocker_id = new.author_id and b.blocked_id = r.user_id)
     )
     -- An @tag is not a grant of access: someone who cannot open the match is
     -- not told about it, and certainly not sent a snippet of it.
     and public.can_user_view_video(r.user_id, new.video_id)
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists notify_on_comment on public.match_comments;
create trigger notify_on_comment
  after insert on public.match_comments
  for each row execute function public.notify_on_comment();

-- ---------------------------------------------------------------------------
-- list_notifications: the inbox, already joined.
--
-- The actor's name and the match's title live behind their own RLS, and the
-- match title in particular may be for a video the recipient could see when the
-- notification was written and cannot now. Resolving it here, under the same
-- visibility check the fan-out used, keeps the inbox to one round trip and
-- keeps a stale row from leaking a title.
-- ---------------------------------------------------------------------------
create or replace function public.list_notifications(p_limit int default 50)
returns table (
  id           uuid,
  kind         text,
  video_id     uuid,
  comment_id   uuid,
  body         text,
  read_at      timestamptz,
  created_at   timestamptz,
  actor_id     uuid,
  actor_name   text,
  video_title  text
)
language sql security definer set search_path = public stable as $$
  select n.id,
         n.kind,
         n.video_id,
         n.comment_id,
         n.body,
         n.read_at,
         n.created_at,
         n.actor_id,
         coalesce(
           nullif(btrim(coalesce(p.display_name, '')), ''),
           nullif(btrim(concat_ws(' ', p.first_name, p.last_name)), ''),
           'Ojo player'
         ) as actor_name,
         v.title as video_title
    from public.notifications n
    left join public.profiles p on p.id = n.actor_id
    left join public.videos   v on v.id = n.video_id
   where n.user_id = auth.uid()
     and public.can_user_view_video(auth.uid(), n.video_id)
   order by n.created_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

grant execute on function public.can_user_view_video(uuid, uuid) to authenticated;
grant execute on function public.can_user_edit_video(uuid, uuid) to authenticated;
grant execute on function public.search_followed_users(text, int) to authenticated;
grant execute on function public.list_notifications(int) to authenticated;
