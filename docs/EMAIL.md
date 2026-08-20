# Transactional email (Resend)

All outbound mail goes through one small layer in `web/lib/email/`:

- **`send.ts`** — `sendEmail({ to, subject, html, text })` posts to Resend. It's the single
  delivery choke point. If `RESEND_API_KEY` is unset it logs and no-ops (so local dev and
  pre-key deploys never crash).
- **`templates.ts`** — a shared branded `layout()` + one function per email type returning
  `{ subject, html, text }`. Adding a new email = add a function here; the shell stays consistent.
- **`invites.ts`** — higher-level helper `sendParticipantInvites(...)` used by the routes.

## Setup (Vercel env)
- `RESEND_API_KEY` — from the Resend dashboard (domain `ojotennis.com` verified, DNS set).
- `EMAIL_FROM` — a verified sender, default `Ojo Tennis <no-reply@ojotennis.com>`.
- `NEXT_PUBLIC_APP_URL` — `https://ojotennis.com` (used for links in emails).

## What sends today
- **Participant invite** — when a match participant is added *by email* and has no Ojo account,
  they get a link to `/invite/<token>`. The token claims the invite, so it works whatever address
  or provider they sign up with (see `0015_invites.sql`). Sent from the participants `PUT` route
  and the upload `initiate` route, only for **newly added** email guests (no re-sends on edit);
  `POST /api/videos/[id]/invites` re-sends one on demand.
- **Added to a match** — when someone who *already* has an account is tagged. They get library
  access from the tag itself, so this is a notification, not an invitation. Before this, being
  tagged by name notified you of nothing at all.

## Delivery is not assumed to work
`sendParticipantInvites` returns a result per address instead of swallowing failures, and the
routes pass it back as `invites: [{ email, url, failed }]`. The web player editor shows the
failures and offers the invite link to copy, so an invite still reaches its recipient when Resend
is misconfigured (an unverified sending domain rejects mail to anyone but your own address —
a silent 403 under the old code). **An invite must never depend on the mail provider being
healthy.**

## Future emails (same pattern — just add a template)
- "A match was shared with you" (share link opened / direct share).
- Welcome email on signup.
- Comment / tag notifications (once those ship).
- Weekly digest of new matches from people you follow (with the following slice).

Each becomes a `templates.ts` function + a call to `sendEmail`; no new infrastructure.
