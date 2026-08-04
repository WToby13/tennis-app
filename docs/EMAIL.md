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
- **Participant invite** — when a match participant is added *by email* (a guest not on Ojo),
  they get an invite to create an account; on signup with that email they're linked to the match
  and it appears in their library (see `0005_participants.sql`). Sent from the participants `PUT`
  route and the upload `initiate` route, only for **newly added** email guests (no re-sends on edit).

## Future emails (same pattern — just add a template)
- "A match was shared with you" (share link opened / direct share).
- Welcome email on signup.
- Comment / tag notifications (once those ship).
- Weekly digest of new matches from people you follow (with the following slice).

Each becomes a `templates.ts` function + a call to `sendEmail`; no new infrastructure.
