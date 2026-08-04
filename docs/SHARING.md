# Ojo — Video Sharing Design

Status: **Slice 1 BUILT** (2026-08-04) — code complete, `tsc` clean, smoke-tested in local
no-auth mode. Pending live steps: run `supabase/migrations/0002_sharing.sql`, then a
two-account end-to-end test on Vercel. The social-feed foundation (`videos.visibility` +
public read path) is included per Toby's "support the feed direction from the start."

Scope of this design: **uploaded recordings**, owner-private by default, shareable by
revocable URL, "Add to my account" for recordings you didn't upload. Google auth and the
annotation layers (tags / clips / comments) are sketched at the end but **not** part of the
first build slice.

---

## 1. Core principle

Two things that today are conflated become **separate concepts**:

| Concept | Meaning | Where it lives |
|---|---|---|
| **Ownership** | who uploaded the original. Immutable, exactly one. | `videos.owner_id` |
| **Library membership** | "this video is in my list." Many users per video. | new `library_items` |

- The **original video is the single source of truth** and never changes owner.
- **"Add to my account" = a new `library_items` row.** No copy, no new S3 object, no owner change.
- **"Show me only my recordings" = the videos I have a `library_items` row for** (which,
  by construction, is the ones I uploaded + the ones I added).
- Every future layer (tags/clips/comments) keys off `(video_id, author_id)` and carries its
  own visibility — it never mutates the original. Same sharing primitive is reused.

### Access is enforced at playback, not just in the DB

Video bytes are only reachable through a **signed CloudFront URL minted server-side**
(`GET /api/videos/[id]`). That route is the real gate: it mints a URL only if the caller is
**owner OR has it in their library OR presents a valid share token**. RLS on the tables is
defense-in-depth *behind* that gate.

---

## 2. What changes from today

Today's model is the opposite of the target and should be tightened before launch:

- `0001_init.sql:65` — `videos readable by authenticated using (true)` → **any signed-in user
  reads every video.**
- `page.tsx` — library calls `store.list()` = **all** videos; copy says *"Everyone signed in
  can watch these."*
- Sharing is just copying `/watch/[id]`, doing no access work (everyone already sees all).

The change: **own-only lists + explicit, revocable share links.**

---

## 3. Schema (migration `0002_sharing.sql`)

```sql
-- 3.1 Soft delete on the original
alter table public.videos add column if not exists deleted_at timestamptz;

-- 3.2 Library membership: which videos are in a given user's list
create table if not exists public.library_items (
  user_id   uuid not null references auth.users(id) on delete cascade,
  video_id  uuid not null references public.videos(id) on delete cascade,
  added_via text not null default 'upload' check (added_via in ('upload','share')),
  added_at  timestamptz not null default now(),
  primary key (user_id, video_id)
);
create index if not exists library_items_user_idx
  on public.library_items(user_id, added_at desc);

-- 3.3 Revocable share links (a bearer capability in the URL)
create table if not exists public.share_links (
  token      text primary key,          -- random url-safe (~22 chars base64url), minted server-side
  video_id   uuid not null references public.videos(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  can_add    boolean not null default true,   -- future: view-only vs add-to-account
  expires_at timestamptz,                      -- null = never
  revoked_at timestamptz,                       -- non-null = dead
  created_at timestamptz not null default now()
);
create index if not exists share_links_video_idx on public.share_links(video_id);

-- 3.4 Uploader is auto-added to their own library
create or replace function public.add_owner_to_library()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.library_items (user_id, video_id, added_via)
  values (new.owner_id, new.id, 'upload')
  on conflict do nothing;
  return new;
end; $$;

drop trigger if exists on_video_created on public.videos;
create trigger on_video_created
  after insert on public.videos
  for each row when (new.owner_id is not null)
  execute function public.add_owner_to_library();

-- 3.5 Backfill existing videos into their owners' libraries
insert into public.library_items (user_id, video_id, added_via)
select owner_id, id, 'upload' from public.videos
where owner_id is not null
on conflict do nothing;
```

### RLS (replacing the permissive policy)

```sql
-- videos: readable only if you own it or it's in your library, and not deleted
drop policy if exists "videos readable by authenticated" on public.videos;
create policy "videos readable by owner or library" on public.videos
  for select to authenticated using (
    deleted_at is null and (
      owner_id = auth.uid()
      or exists (select 1 from public.library_items li
                 where li.video_id = videos.id and li.user_id = auth.uid())
    )
  );
-- insert/update/delete owner-only policies unchanged from 0001.

-- library_items: you only see/manage your own rows
alter table public.library_items enable row level security;
create policy "own library rows" on public.library_items
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- share_links: only the creator manages them; token resolution is via the RPCs below
alter table public.share_links enable row level security;
create policy "own share links" on public.share_links
  for all to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
```

### The two share operations run as `security definer` RPCs

RLS can't see the token in the URL, so the "view via link" and "add via link" paths go through
definer functions that encapsulate the token check. Tables stay strict (owner/self only); these
are the controlled escape hatches. This is the standard Supabase capability pattern.

```sql
-- Resolve a share token → the video (bypasses the strict SELECT policy, safely)
create or replace function public.get_shared_video(p_token text)
returns public.videos language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  select vi.* into v
  from public.share_links s join public.videos vi on vi.id = s.video_id
  where s.token = p_token
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and vi.deleted_at is null;
  if not found then raise exception 'invalid or expired share link'; end if;
  return v;
end; $$;

-- Add-to-my-account via a valid, add-enabled token (inserts for the caller)
create or replace function public.add_shared_video(p_token text)
returns public.videos language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  select vi.* into v
  from public.share_links s join public.videos vi on vi.id = s.video_id
  where s.token = p_token and s.can_add
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and vi.deleted_at is null;
  if not found then raise exception 'invalid or expired share link'; end if;
  insert into public.library_items (user_id, video_id, added_via)
  values (auth.uid(), v.id, 'share') on conflict do nothing;
  return v;
end; $$;
```

**Open note — token storage:** tokens are stored in plaintext (a bearer capability). Fine for
MVP. If you want to harden later, store a hash and look up by hash (like a password-reset token)
so a DB read can't replay links.

---

## 4. API routes

| Route | Change | Notes |
|---|---|---|
| `GET /api/videos` | **Own-only.** List via `library_items` join, ordered by `added_at`. | RLS already restricts, but join gives correct ordering + the `added_via` flag. |
| `GET /api/videos/[id]?s=<token>` | If owner/in-library → normal path. Else if `s` valid → `get_shared_video` RPC, mint playback URL, return `{ inLibrary:false, canAdd:true }`. | The route stays the playback gate. |
| `POST /api/videos/[id]/share` | **New.** Owner mints (or returns existing) share link → `{ url }`. | Optional `DELETE` to revoke. |
| `POST /api/videos/[id]/add` | **New.** Body `{ token }` → `add_shared_video` RPC. | The "Add to my account" button. |
| `DELETE /api/videos/[id]` | Owner → **soft-delete** (`deleted_at`) + purge S3 bytes. | See §6. |
| `DELETE /api/videos/[id]/library` | **New.** Non-owner → remove *their* `library_items` row (not the video). | "Remove from my library." |

Uploader auto-add is handled by the DB trigger (§3.4), so `initiate` needs no change.

---

## 5. UI + auth flows

- **Library (`page.tsx`)**: copy changes to "Only you can see these." Items added via a link get
  an "Added" tag and a "Remove from my library" action (vs. owner's "Delete").
- **Watch (`watch/[id]/page.tsx`)**:
  - Owner → "Share" now **POSTs to create a link** and copies `/watch/[id]?s=<token>` (today it
    copies the bare id URL). Later: manage/revoke.
  - Non-owner arriving via token, not yet in library → **"Add to my account"** button (POST /add).
- **Login return flow (share links for logged-out friends):**
  1. Middleware, when bouncing to `/login`, appends `?next=<original path+query>` (so the `?s=`
     token survives).
  2. `login/page.tsx` reads `next` and redirects there after sign-in/sign-up (today it always
     pushes `/`).
  - Full path: open link → login → back to the same watch page → "Add to my account."

---

## 6. Deletion semantics (chosen: soft-delete, disappears for all)

- Owner delete → set `videos.deleted_at`, hide everywhere (RLS filters it), **purge S3 bytes**.
- Everyone who added it loses access (it's the owner's video). Future clips/comments cascade.
- Non-owner "delete" is a different action = **remove their `library_items` row** only.
- Keep the soft-deleted row for FK integrity/audit; a later cron can hard-purge old rows.
- **Future-proofing guard (do this in Slice 1):** keep "hide the row" and "purge S3 bytes" as
  two *separate* steps. Once clips exist (§9), byte-purge becomes conditional on no surviving
  clip needing the source — making that a policy change, not a redesign.

---

## 7. Out of scope now — but the design already fits

- **Google auth (later, small):** enable Google provider in Supabase + a Google Cloud OAuth
  client; add a button calling `signInWithOAuth({ provider:'google', options:{ redirectTo:
  <origin>/auth/callback?next=... }})`. The existing `auth/callback/route.ts` already exchanges
  the code. iOS: `ASWebAuthenticationSession` later.
- **Participants ("who played"):** later `video_participants (video_id, user_id | name)` so
  comments/tags can be "shared with who played." "Add to my account" and "I was in this match"
  may merge.
- **Annotation layers (tags / clips / comments):** separate tables keyed by `(video_id,
  author_id)`, each with `visibility` (`private` / `participants` / `public`), reusing the
  share/visibility primitive. **Clips = virtual ranges `(video_id, start_s, end_s)`** rendered
  by seeking the original (non-destructive, free, instant); only ffmpeg-render to a new S3
  object on export/download.

---

## 8. Build order (once approved)

1. **Slice 1 (this design):** migration + RLS + RPCs; own-only list; share-link create; add-to-
   account; login `?next=` flow; soft-delete; remove-from-library. Verify end-to-end (two
   accounts) locally + on Vercel.
2. **Slice 2:** participants; Google auth.
3. **Slice 3:** annotation layers (tags/clips/comments) with visibility + virtual clips.

### iOS impact
Web-only slice. iOS "View" opens the web watch URL, so it inherits share/add. iOS library is
local recordings and is unaffected; no rebuild needed for Slice 1.
```

---

## 9. Pressure test vs future directions (2026-08-04)

Verdict: the core (ownership≠library-membership, original-as-source-of-truth, `(subject,author,
visibility)` layers, capability tokens) **extends to both futures additively — no rewrite.**
Two load-bearing assumptions must evolve, one of which contradicts a decision above.

### A. Social feed (Strava-like): clips that outlive originals, reels, follows, likes

- **Conflict with §6:** "clips survive if the original is deleted" contradicts virtual-ranges +
  purge-on-delete. **Fix:** clips become first-class objects, *virtual until published*:
  `clips(id, source_video_id, author_id, start_s, end_s, visibility, materialized_key,
  thumb_key)`. Virtual (cheap) while private; **materialize to own S3 object on publish**; and
  **copy-on-delete** (materialize surviving clips before purging a source). "Clip survives" =
  "clip was published, or its source was deleted." This is the one revision to make.
- **Reels:** `reels(id, author_id, title, visibility)` + `reel_items(reel_id, clip_id, position)`.
  3-level hierarchy reels→clips→videos. Materialize on publish.
- **Social (all additive):** `follows`, `likes(user_id, post_id)`, and a unifying
  `posts(id, author_id, subject_type∈{clip,reel,video}, subject_id, visibility)`. Feed =
  followees' visible posts, newest first (fan-out-on-read is fine at this scale).
- **`visibility` grows** to `private | participants | followers | public`. Two orthogonal
  sharing mechanisms now coexist: capability *tokens* (one person) + graph *visibility* (who in
  the graph). Keep both.
- **Consent:** non-owner clipping/reposting a shared match makes someone else's video public →
  need source-level `allow_clipping`/`allow_public_repost` + participant consent.

### B. Clubs / fixed cameras / scheduled recording

- **Breaks `owner_id = one auth user`:** the recorder is a *device* owned by a *club*; players
  come from a *booking*. **`library_items` already solves player access** — record court3@4pm →
  create video → insert `library_items` for A and B; they see it like a shared video. This is
  the payoff of splitting ownership from membership.
- **Net-new tables:** `clubs`, `courts`, `devices` (device auth, NOT user JWT), `bookings`
  (schedule → participants), `club_members(role)`. Generalize `videos` with `source∈{upload,
  device}`, nullable `club_id`/`court_id`. `video_participants` (deferred Slice 2) becomes
  central, derived from the booking.
- **Two hard net-new subsystems (real projects, not schema tweaks):** (1) ingestion + matcher
  (device upload → stamp club/court/time → join to booking → grant + participants); (2)
  **recording control plane** (start/stop on schedule → device commands via poll/websocket/MQTT
  + clock sync + offline buffer) — the biggest new piece, outside the storage schema.
- **Also triggered:** multi-tenant RLS (participant-or-staff; push heavy checks into
  `security definer` fns); faststart/processing at scale (the deferred ffmpeg-Lambda decision)
  + AI auto-highlights become valuable; **GDPR/consent is a first-class blocker** (identifiable
  people incl. minors on court, esp. DK/FR).

### What to lock in Slice 1 so we don't corner ourselves
Slice 1 already routes access through `library_items` (not raw `owner_id`), so both futures
inherit it. Only two cheap guards: (1) the split hide-vs-purge step in §6; (2) never hard-code
`owner_id` as the sole access check — always go through library membership. Everything else is
additive later; pre-building the club control plane now would be the mistake.
