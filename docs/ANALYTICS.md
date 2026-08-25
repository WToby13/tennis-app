# Ojo — Analytics

Written 2026-08-23. Closes blocker #4 in [`GTM.md`](GTM.md) ("No analytics — the
Phase 0 numbers can't currently be measured") and makes the four metrics in
[`GTM.md` §6](GTM.md) real.

---

## 1. The shape of it

Two layers, doing two different jobs.

| | What it answers | Where it lives |
|---|---|---|
| **Product events** | Did the loop work? Did the upload finish? Did anyone watch it twice? | Our own Postgres, table `events` |
| **Vercel Web Analytics** | Where did signed-out web traffic come from? | Vercel, `@vercel/analytics` |

**There is no third-party analytics SDK, in either client.** That is a deliberate
choice and not just frugality:

1. **The questions are joins.** "Share rate = matches shared ÷ matches uploaded"
   and "second-watch = watched again a day later" are SQL over rows we already
   own. Shipping all that context to a vendor so we can re-join it there, in
   their query language, would be strictly worse.
2. **It keeps the App Store label honest.** First-party, nothing shared with a
   data broker, no advertising identifier, so *"used for tracking: No"* stays
   true and there is no App Tracking Transparency prompt. See
   [`APPSTORE.md` §8](APPSTORE.md).
3. **It is free at this volume.** A few thousand rows a month.

Revisit if you want session replay, or pass roughly a million events a month.
Adding PostHog later is easy — the events table has the same shape as what you'd
send it.

---

## 2. Where events come from

**Server-side by default.** Most events are written from the API route that
performed the action ([`web/lib/analytics/server.ts`](../web/lib/analytics/server.ts)).
A route event cannot be blocked by an extension, cannot be double-fired by a
React re-render, and cannot claim something that didn't happen —
`upload_completed` written from `POST /uploads/:id/complete` means the multipart
upload genuinely assembled.

It also means **iOS gets most events for free**: the phone calls the same routes
the browser does, so sharing, adding to a library and completing an upload are
all recorded without a line of Swift.

**Client-side only for what the server can't see:** a play button being pressed,
a signed-out visitor hitting the sign-in wall, a share link being opened at all.

`track()` on the server uses Next's `after()`, so the insert happens once the
response has flushed. Do not replace it with a floating promise — on Vercel the
function is frozen the moment the response returns, and the insert would be lost
about as often as not.

| Where | File |
|---|---|
| Event vocabulary (the allow-list) | [`web/lib/analytics/events.ts`](../web/lib/analytics/events.ts) |
| Server writer | [`web/lib/analytics/server.ts`](../web/lib/analytics/server.ts) |
| Browser client | [`web/lib/analytics/client.ts`](../web/lib/analytics/client.ts) |
| Ingest endpoint | [`web/app/api/events/route.ts`](../web/app/api/events/route.ts) |
| iOS client | [`ios/Ojo/Ojo/Analytics.swift`](../ios/Ojo/Ojo/Analytics.swift) |
| Schema + metric views | [`supabase/migrations/0019_events.sql`](../supabase/migrations/0019_events.sql) |
| Retention job | [`supabase/migrations/0020_schedule_events_retention.sql`](../supabase/migrations/0020_schedule_events_retention.sql) |
| Tests | [`supabase/tests/events_test.sql`](../supabase/tests/events_test.sql) |

**`events.ts` and the `Event` enum in `Analytics.swift` are the same list twice.**
Swift can't import the TypeScript, and `/api/events` allow-lists against the
TypeScript — so a name added to one and not the other is silently dropped.

---

## 3. Reading the numbers

Five views, in the Supabase SQL editor. They are granted to nobody, so they are
readable there (which connects as the owner) and nowhere else.

```sql
select * from metrics_share_rate;              -- GTM §6, loop input
select * from metrics_share_conversion;        -- GTM §6, loop multiplier
select * from metrics_second_watch;            -- GTM §6, was it useful
select * from metrics_recording_retention;     -- GTM §6, habit or toy
select * from metrics_upload_reliability;      -- does a big upload survive club Wi-Fi
```

Every denominator comes from events too, never from `videos`. That keeps the
numerator and denominator over the same instrumented window, so a ratio isn't
dragged down by matches that predate any of this existing.

Three things worth knowing before you read them:

- **`metrics_share_conversion.hit_sign_in_wall` is the point of that view.**
  GTM blocker #2 says a shared `/watch` link bouncing a signed-out recipient to
  `/sign-in` is the biggest single conversion win available. That is a
  reasonable belief and has never been a number. It is one now — *before* the
  wall comes down, so the fix can be judged rather than assumed.
- **Identity stitching.** The browser keeps sending its `anon_id` after sign-in
  and the server stamps `user_id` on those same rows; any event carrying both
  says "this anonymous visitor became this account". That bridge is what lets a
  server-side `library_add`, which has never heard of an `anon_id`, be credited
  back to the share link that caused it.
- **Anonymous ids do not survive the tab closing** (§5). Someone who opens a
  link today and signs up tomorrow counts as two people, so share conversion
  **under-reports**. Treat it as a floor.

Build an `/admin` page when the SQL editor gets tiresome, not before. If you do,
grant the specific view and think about it then.

---

## 4. Who can read the table

`events` has RLS enabled and **no policies at all**, plus an explicit revoke.
Under RLS, a table with no matching policy denies everything — so no signed-in
user can read it through the API, including the person the rows are about.
Writes come only from the service role in `/api/events`.

The revoke is the half that is easy to miss: Supabase's default privileges grant
every new public table to `anon` and `authenticated`, so without it the table
would become readable the moment RLS were disabled for a migration.
`events_test.sql` asserts all of this, because it is the kind of mistake that
fails open and silently.

`/api/events` is a **public** endpoint, and has to be — the most valuable row in
the funnel is written by someone with no account. So it is written defensively:

- `user_id` comes from the verified session, never the body. A caller cannot
  attribute events to someone else's account.
- Names are allow-listed; anything else is dropped.
- `props` is flattened to primitives, capped at 12 keys and 4 KB (enforced again
  by a check constraint on the column).
- Timestamps are clamped to the last 7 days, so an offline batch can be
  backdated a little but history can't be rewritten.
- A per-instance rate limit (120 events/minute, keyed by account or anon id).
  On serverless each instance has its own copy and a cold start resets it, so
  this is a speed bump, not a real limiter. If it ever needs to be one, move the
  counter to Postgres or Vercel KV.

---

## 5. The privacy decisions, and why

These were choices, so they are written down rather than left to be
re-discovered.

**No cookie; `sessionStorage` for the anonymous id.** Under PECR, storing
anything on a device that isn't strictly necessary needs consent, and analytics
is not strictly necessary — a persistent cross-visit identifier would mean a
consent banner. `sessionStorage` scopes the id to the visit rather than to the
person. The cost is the under-reporting in §3. If cross-visit attribution ever
matters more than a banner costs, that is the trade to revisit, and it is a
legal decision as much as a technical one.

**iOS keeps its ids in memory only**, regenerated every 30 minutes. Nothing
identifying is written to the device, so there is no persistent identifier to
declare on the App Store label. Signed-in events are attributed server-side from
the Bearer token anyway.

**Legitimate interests, therefore an opt-out.** `/privacy` claims legitimate
interests as the lawful basis, and UK GDPR Article 21 gives a right to object to
exactly that. So the switch is not a nicety:

- iOS: **Settings → Privacy → Share usage data**
- Web: **profile → Usage data**

Both stop collection immediately and discard anything unsent. The web toggle
also gates Vercel Web Analytics through its `beforeSend`, so someone who opts out
isn't still being counted there.

**Twelve-month retention**, enforced by the pg_cron job in 0020. Without that
job the sentence in `/privacy` is a wish. Deleting an account deletes that
account's events at once, by `on delete cascade` — the cost being that aggregate
history shifts retroactively when someone leaves, which is the right way round.

**What is never collected:** any part of a video or a frame of one, comment text,
search queries, contacts, location, IP addresses, or any advertising or device
identifier.

---

## 6. If you change this, change these too

Adding an event is cheap. Changing *what kind* of thing is collected is not,
because three documents make promises about it:

1. **[`/privacy`](../web/app/privacy/page.tsx)** — the "How you use the app"
   section lists the events by name. It is the source of truth Apple compares
   the label against.
2. **[`APPSTORE.md` §8](APPSTORE.md)** — the privacy label, and §8.1 which
   describes exactly what the analytics row covers.
3. **This file.**

And if you ever add a third-party SDK, all three become false at once, plus the
"used for tracking" answer needs re-thinking and ATT may come into play. It is a
bigger decision than it looks.

---

## 7. Operational notes

- **`SUPABASE_SERVICE_ROLE_KEY` is now required in production.** Without it
  `analyticsEnabled()` is false and every event is silently dropped — no errors,
  no rows, which is a quiet way to discover this in a month. It was already
  needed for the cron sweep, so a correctly configured deployment has it.
- **Local dev collects nothing.** `npm run dev:local` has no Supabase, so
  `/api/events` accepts and discards. The clients behave identically either way.
- **Run the migrations in order**, 0019 then 0020, in the Supabase SQL editor.
  0020 needs `pg_cron`, which is already enabled by 0012.
- **The test suite runs offline**: `supabase/tests/run.sh`, no Supabase project
  and no network. It skips 0012 and 0020 (pg_cron), which only *schedule* work
  whose functions are defined in ordinary migrations and are covered.
