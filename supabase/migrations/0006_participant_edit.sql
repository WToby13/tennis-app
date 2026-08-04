-- Participants can edit a match (rename, change players) — everything but delete.
-- Done via security-definer RPCs so we DON'T have to open the videos UPDATE policy
-- (which would also expose owner_id / visibility / deleted_at). Delete stays
-- owner-only (unchanged videos DELETE/UPDATE policies).
-- Run in the Supabase SQL editor after 0005_participants.sql.

-- Who may edit a video: its owner, or anyone tagged as a participant.
-- SECURITY DEFINER so the reads bypass RLS — this also breaks the policy
-- recursion that a direct video_participants self-reference would cause.
create or replace function public.can_edit_video(p_video_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.videos v
                 where v.id = p_video_id and v.owner_id = auth.uid())
      or exists (select 1 from public.video_participants vp
                 where vp.video_id = p_video_id and vp.user_id = auth.uid());
$$;
grant execute on function public.can_edit_video(uuid) to authenticated;

-- Broaden participant management from owner-only to any editor.
drop policy if exists "owner manages participants" on public.video_participants;
create policy "editors manage participants"
  on public.video_participants for all
  to authenticated
  using (public.can_edit_video(video_id))
  with check (public.can_edit_video(video_id));

-- Rename: definer RPC that touches ONLY the title.
create or replace function public.update_video_title(p_video_id uuid, p_title text)
returns public.videos language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  if not public.can_edit_video(p_video_id) then
    raise exception 'not allowed to edit this video';
  end if;
  update public.videos set title = p_title
   where id = p_video_id and deleted_at is null
   returning * into v;
  if not found then raise exception 'video not found'; end if;
  return v;
end;
$$;
grant execute on function public.update_video_title(uuid, text) to authenticated;

-- Replace the participant list in one call. Checking can_edit_video ONCE up front
-- (then deleting + inserting as definer) avoids a mid-operation RLS failure when a
-- participant editor momentarily removes their own row. Triggers still fire, so
-- library grants stay correct.
create or replace function public.set_participants(p_video_id uuid, p_participants jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_edit_video(p_video_id) then
    raise exception 'not allowed to edit this video';
  end if;
  delete from public.video_participants where video_id = p_video_id;
  insert into public.video_participants (video_id, user_id, display_name, email, added_by)
  select p_video_id,
         nullif(elem ->> 'userId', '')::uuid,
         elem ->> 'displayName',
         nullif(elem ->> 'email', ''),
         auth.uid()
  from jsonb_array_elements(coalesce(p_participants, '[]'::jsonb)) as elem
  where coalesce(elem ->> 'displayName', '') <> '';
end;
$$;
grant execute on function public.set_participants(uuid, jsonb) to authenticated;
