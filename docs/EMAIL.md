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

## Receiving mail (`support@`, `privacy@`)

Both addresses are published in the privacy policy, the terms and the App Store
listing, so they must not bounce — and until this is set up, they do: the domain
has no `MX` record, so nothing accepts mail for it at all.

Resend can *receive* but has no forwarding switch. Receiving raises an
`email.received` webhook carrying only metadata; [`app/api/inbound/route.ts`](../web/app/api/inbound/route.ts)
verifies the signature and calls the SDK's `receiving.forward()`. The original
message goes on intact, with **Reply-To set to whoever wrote in** — so replying
in Gmail answers them, not you.

### Setup (once)

1. **Resend → Domains → `ojotennis.com` → enable Inbound.** Copy the `MX` record
   it gives you.
2. **Simply.com DNS → add that `MX` on the root domain.** Nothing to conflict
   with: there are no `MX` records today, and the sending setup is on the
   `send.` subdomain, which this does not touch.
3. **Resend → API Keys → create a key with _full access_**, and set it as
   `RESEND_INBOUND_API_KEY`. This cannot be the sending key: forwarding reads
   the received message, and a sending-only key fails with `restricted_api_key`.
4. **Resend → Webhooks → add endpoint** `https://ojotennis.com/api/inbound`,
   event **`email.received`**. Copy the signing secret (`whsec_…`).
5. **Vercel → Environment Variables**, then redeploy:
   - `RESEND_WEBHOOK_SECRET` — the `whsec_…` from step 4
   - `RESEND_INBOUND_API_KEY` — the full-access key from step 3
   - `INBOUND_FORWARD_TO` — the inbox mail should land in
6. **Test:** email `support@ojotennis.com` from a phone. It should arrive within
   a few seconds; check Reply goes back to the sending address, not to yourself.

### Notes

- The route returns **500 on failure so Resend retries.** Mail waiting for a
  fix beats mail accepted and dropped.
- `/api/inbound` is in the middleware's public list — the webhook arrives with
  no session and authenticates by signature instead.
- Verified locally with real HMACs: bad signature → 401, valid → forwards, valid
  signature over a tampered body → 401, non-`email.received` → ignored.
- Anything sent to an address that isn't routed still bounces. Resend Inbound
  can catch-all the domain, which is what you want here — two addresses are
  published and typos happen.

### If the Resend account holds more than one domain

**Resend webhooks cannot be scoped to a domain.** Creating one takes an endpoint
and a list of events, and nothing else — so *every* endpoint on the account is
called for *every* inbound message on the account, whichever domain it was
addressed to.

With two projects sharing one Resend account, each one's handler sees the
other's mail. That is not only a duplicate in the inbox: the other project
forwards it, logs its subject and sender, and becomes an undeclared processor of
mail sent to an address whose privacy policy does not name it.

This route therefore forwards only mail addressed to `INBOUND_DOMAIN`, checking
`to`, `cc`, `bcc` and `received_for` (an alias delivers to one address while the
visible `To:` still says another). Anything else returns 200 and is dropped —
200 rather than an error, because a non-2xx would make Resend retry a message
that is correctly not ours.

**Any other project on the same Resend account needs the same guard**, or it
will keep forwarding Ojo's support mail into its own logs and inbox. The
alternative is a separate Resend account per project, which is the cleaner
separation if the projects have different data-protection stories — and Ojo's,
which handles video of identifiable people, arguably does.

## Future emails (same pattern — just add a template)
- "A match was shared with you" (share link opened / direct share).
- Welcome email on signup.
- Comment / tag notifications by email. The in-app inbox ships them already
  (`0017_notifications.sql` + `/api/notifications`); email would be a second
  delivery channel off the same rows, and wants an unsubscribe preference before
  it goes anywhere near a digest.
- Weekly digest of new matches from people you follow (with the following slice).

Each becomes a `templates.ts` function + a call to `sendEmail`; no new infrastructure.
