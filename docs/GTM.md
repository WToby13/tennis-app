# Ojo — Go-to-market

Written 2026-08-13, ahead of launch. Companion to [`ROADMAP.md`](ROADMAP.md) (what gets
built) — this is who it's for, how they find it, and what has to be true before
telling anyone.

---

## 1. The position

> **Ojo Tennis is the app that makes your own match watchable.**

Not a coaching product, not a stats product, not a line-calling product. The wedge
is narrower and much easier to explain: *most club players have never once seen
themselves play,* and the reason isn't cost or technology — it's that filming a
match produces a 4 GB file that is unwatchable. Two hours long, no way to find a
point, sitting in a camera roll nobody opens.

Ojo removes the three frictions in that sentence:

| Friction | What Ojo does |
|---|---|
| Filming is a faff | A phone at the back of the court. No rig, no mount, no box on a pole. |
| The file is unusable | Chunked upload that survives club Wi-Fi; large matches compressed, not refused. |
| Two hours, no index | AI breakdown marks each rally and groups them into service games. |

**Who we're not.** SwingVision, Baseline Vision and the court-camera systems
(PlaySight, Wingfield) all sell *analysis* — stats, line calls, shot placement —
and mostly need hardware, a subscription, or both. Ojo sells *seeing it*. That's
a smaller promise and a much cheaper one to keep, and it's the promise a 4.0
club player actually has an unmet need for. If we later add stats, we add them
to an audience already uploading matches. Do not lead with them.

**Who it's for, concretely.** Club players who play a regular weekly match with
the same handful of people, own an iPhone, and have at some point said "I have
no idea what my serve actually looks like." Age 25–55, plays at a club or public
courts, not coached weekly.

---

## 2. The growth mechanic — build on this, not on ads

The product has a real loop already built, and it is the whole GTM plan:

```
A records a match  →  A shares the link with B (the person they just played)
                   →  B opens it, sees themselves play, wants to keep it
                   →  B adds it to their library  →  B needs an account
                   →  B records their next match
```

This is unusually strong because **tennis is played in pairs**. Every single
match recorded has exactly one other person with a personal reason to want the
footage. Nothing else in the funnel matters as much as making that handoff
smooth, so:

- **The unfurl is the landing page.** The link gets pasted into WhatsApp and
  iMessage. What B sees first is the preview card, not ojotennis.com. (Fixed —
  see §5.)
- **B must be able to watch before committing.** Today a shared `/watch/:id`
  link bounces B to `/sign-in?next=…`. That is a wall in front of the single
  highest-intent moment in the entire funnel. **Highest-leverage unshipped
  change:** let a valid share token render the match read-only with no account,
  and put "Add this to my library" behind sign-up. Watch first, then decide.
- **Prompt the share.** When a match finishes processing, the owner should be
  asked "send this to who you played?" rather than having to find the button.

Spend on this loop before spending anything on acquisition. A referral scheme, a
paid campaign or an influencer are all worse than removing the sign-in wall.

---

## 3. Launch sequence

### Phase 0 — Ten people (now)
Not a launch. Give it to the players you actually hit with, in person, and watch
them use it. Goal is one number: **of matches recorded, what fraction get shared,
and of those shares, what fraction convert the recipient?** If shares don't
convert, nothing later works — fix that before widening.

Watch for: uploads that fail on club Wi-Fi, an analysis run that comes back
wrong, and whether anyone goes back and watches a match a *second* time.

**This does not need the App Store, and it was wrong to assume it did.**
Blocker #3 is waiting on Apple's identity check and could sit for a week. But
every step of the loop above already works in a browser:

| Step | Without the app |
|---|---|
| Film the match | The stock iPhone Camera app. It is a phone at the back of the court either way |
| Get it in | Drag or pick the file on `/matches` — the web uploader takes `video/*` and uses the same multipart path |
| Share it | Unchanged; the share link is a web link |
| Recipient watches, adds it, signs up | Unchanged; all of it is the website |
| Measure all four numbers | Unchanged — the events are written by the API routes both clients call |

What the iOS app adds is *capture convenience and a resumable upload that
survives club Wi-Fi* — real, and the reason it exists, but not a precondition
for finding out whether people share matches and whether recipients convert.
Those are the two questions Phase 0 exists to answer, and they can be answered
now with five people and no Apple account.

The honest caveat: a web upload of a 4 GB file from a phone is exactly the
fragile thing `BackgroundUploader` was written to fix, so expect failures and do
not read them as the product being broken. Keep Phase 0 matches short, or upload
from a laptop over Wi-Fi.

### Phase 1 — One club (weeks 2–6)
Your own club. This is where the loop compounds, because members already play
each other — a recipient today is a recorder next week. Tactics that fit and
don't feel like marketing:

- The club WhatsApp group / noticeboard. One post, plain: "I built a thing that
  records your match so you can watch it back. Free, looking for people to break
  it."
- The club coach. A coach with even one player using it becomes a distribution
  channel, and "send me the match beforehand" is a genuinely useful thing for
  them. Give coaches nothing special — the share link already works.
- Box leagues and club ladders: recurring, competitive, and every match has a
  named opponent to send it to.

### Phase 2 — Beyond the club (month 2+)
Only after Phase 1 retains. In rough order of effort-to-payoff:

1. **r/tennis and r/10s.** "Watch your own match back" posts do well there. Lead
   with the footage, not the product.
2. **Neighbouring clubs and county leagues.** The same box-league dynamic.
3. **Search.** The SEO/GEO work in §5 is a slow compounder — it pays off in
   month 4, not week 2. Set it up now, judge it later.
4. **Content.** One genuinely useful post — *"How to film your own tennis match
   with just a phone"* — is worth more than a blog. It ranks, it's the exact
   query of someone about to become a user, and it ends with the product.

### What to skip
Paid acquisition, App Store ads, an influencer, a Product Hunt launch. At this
stage every one of them buys traffic the funnel can't yet convert.

---

## 4. Blockers before telling anyone

These are launch-gating, ordered by severity. The first two came out of the
review on 2026-08-13.

| # | Blocker | Status |
|---|---|---|
| 1 | `robots.txt`, `sitemap.xml`, the OG card and the PWA manifest were all being 307'd to `/sign-in` by the middleware — invisible to Google, and every shared link unfurled as a bare URL | **fixed** — [`web/middleware.ts`](../web/middleware.ts) |
| 2 | Shared `/watch/:id` links wall the recipient behind sign-in at the highest-intent moment (§2) | **open** — biggest single conversion win, and now **measurable before it is fixed**: `metrics_share_conversion.hit_sign_in_wall` counts exactly who this happens to |
| 3 | iOS recorder not on TestFlight (needs a paid Apple Developer account) | **waiting on Apple** — enrolment submitted, sitting in identity verification as of 2026-08-23. The app itself is submission-ready. Nothing in the repo blocks it; see [`APPSTORE.md` §4.1](APPSTORE.md). **Note this no longer blocks Phase 0** — see §3 |
| 4 | No analytics — the Phase 0 numbers above can't currently be measured | **fixed** 2026-08-23 — first-party events in Supabase plus Vercel Web Analytics, see [`ANALYTICS.md`](ANALYTICS.md). All four §6 numbers are queryable |
| 5 | Phase 5 media pipeline (faststart) — scrubbing is the core promise and it's rough without it | **open** — [`ROADMAP.md`](ROADMAP.md) |
| 6 | No privacy policy / terms. Storing video of identifiable people; needed before a public sign-up form, and before an App Store submission | **fixed** — [`/privacy`](../web/app/privacy/page.tsx) and [`/terms`](../web/app/terms/page.tsx), both public. Still worth a solicitor's eye before launch |

Nothing here needs a rebrand or a redesign. Items 2 and 3 are the two that
change the shape of the funnel.

---

## 5. SEO and GEO — what was done, and what's left

Shipped 2026-08-13:

- **Crawler files unblocked** (blocker #1). `robots.txt`, `sitemap.xml`,
  `llms.txt`, the OG image and the manifest now bypass the auth middleware.
- **`/robots.txt`** ([`web/app/robots.ts`](../web/app/robots.ts)) — allows the
  marketing pages, disallows everything behind auth so share tokens on `/watch`
  links stay out of index reports.
- **`/sitemap.xml`** ([`web/app/sitemap.ts`](../web/app/sitemap.ts)).
- **Social card** ([`web/app/opengraph-image.tsx`](../web/app/opengraph-image.tsx))
  — generated at 1200×630, inherited by every route *including* `/watch/:id`,
  which is the link that actually gets shared. This is the single most-seen
  surface the product has.
- **Full metadata** ([`web/app/layout.tsx`](../web/app/layout.tsx)) — title
  template, description, canonicals, Twitter card, `max-image-preview:large` so
  AI Overviews can quote a full snippet.
- **Landing page rebuilt for extraction** — a definitional first sentence
  ("Ojo Tennis is a tennis video app that…"), a How-it-works list, and eight FAQs.
- **JSON-LD** ([`web/app/landing/jsonld.tsx`](../web/app/landing/jsonld.tsx)) —
  `Organization` + `WebSite` + `SoftwareApplication` + `FAQPage` in one `@graph`.
- **`/llms.txt`** ([`web/public/llms.txt`](../web/public/llms.txt)) — the emerging
  convention for telling answer engines plainly what a product is, is for, and
  is *not*.
- **Fonts self-hosted** via `next/font` instead of a render-blocking Google Fonts
  stylesheet — LCP is a ranking input and the landing page is the page being ranked.

### Why GEO gets its own effort here

"Best way to record your tennis match" is increasingly answered by ChatGPT,
Perplexity and AI Overviews rather than ten blue links, and those systems quote
sentences. They can't quote a hero image or a feature grid. Everything in the
list above optimises for one thing: **being liftable.** A self-contained answer
that survives being pulled out of the page and pasted into a chat window. That's
why each FAQ answer repeats its own subject, why `llms.txt` includes a "what it
does not do" section (the fastest way to stop being described wrongly), and why
the JSON-LD states the price explicitly rather than leaving it to be guessed.

### Still to do (manual, ~1 hour, none of it code)

1. **Google Search Console** — verify `ojotennis.com` (DNS TXT via Simply.com),
   submit `https://ojotennis.com/sitemap.xml`, request indexing on `/landing`.
2. **Bing Webmaster Tools** — import from Search Console in one click. Worth it
   only because **ChatGPT search and Copilot are Bing-backed**, so this is a GEO
   task more than an SEO one.
3. **Validate the structured data** — [Rich Results Test](https://search.google.com/test/rich-results)
   on `https://ojotennis.com/landing`; expect FAQ to pass.
4. **Check the unfurl for real** — paste a link into iMessage, WhatsApp and Slack.
   Facebook's [Sharing Debugger](https://developers.facebook.com/tools/debug/) can
   force a re-scrape if a stale preview is cached.
5. **Claim the name elsewhere** — an entity with no external footprint is one an
   answer engine won't cite. A GitHub org, an X/Instagram handle and a one-line
   Crunchbase entry all help "Ojo Tennis" resolve as a *thing* rather than two words.
6. **The one content page** — `/how-to-film-your-tennis-match`. Highest-intent
   query in the category, near-zero competition, and it is the honest answer to a
   question people genuinely ask.

### Deliberately not done

- **`/` still 307s to `/landing`** for signed-out visitors, so the indexed URL is
  `ojotennis.com/landing`, not the bare domain. Fixing it properly means
  *rewriting* rather than redirecting, and [`Shell.tsx`](../web/app/Shell.tsx)
  picks its layout from `usePathname()` — under a rewrite that returns `/`, which
  is also the signed-in feed, so the landing page would render inside the app
  sidebar. Needs a layout-group restructure, not a one-liner. Cosmetic; it costs
  us the pretty URL in search results and nothing else.
- **No blog.** One page that ranks beats twelve that don't.

---

## 6. What to measure

Four numbers. Everything else is decoration at this stage.

| Metric | Why it's the one that matters |
|---|---|
| **Share rate** — matches shared ÷ matches uploaded | The loop's input. If people record and don't share, there is no growth mechanic, only an app. |
| **Share conversion** — recipients who create an account ÷ links opened | The loop's multiplier. Blocker #2 is almost certainly what's capping this. |
| **Second-watch rate** — matches watched again ≥1 day later | The honest retention signal. A match watched once was a novelty; watched twice, it was useful. |
| **Week-4 recording retention** | Whether it became a habit or a toy. |

All four are instrumented as of 2026-08-23 (blocker #4). They are SQL views in
Supabase — `metrics_share_rate`, `metrics_share_conversion`,
`metrics_second_watch`, `metrics_recording_retention` — read from the SQL editor.
[`ANALYTICS.md`](ANALYTICS.md) explains the design and, more importantly, the
two caveats worth knowing before quoting a number from them: share conversion
**under-reports** (anonymous ids don't survive a tab closing, a deliberate choice
to stay out of cookie-banner territory), and every denominator starts on
2026-08-23, so the first week's cohorts are partial.

The hunch behind blocker #2 was the main reason to build this before launching
rather than after. `metrics_share_conversion` has a `hit_sign_in_wall` column, so
what the wall costs is a number *now*, and removing it can be judged rather than
believed.

A fifth view, `metrics_upload_reliability`, isn't a GTM number but is the thing
most likely to sink a first release: it reports completion rate and total part
retries per week, which is the field evidence OPERATIONS §1 has never had.

---

## 7. Naming and the domain

"Ojo" is *eye* in Spanish, and `¡ojo!` is idiomatic for "watch out / look here" —
a genuinely good name for a product about seeing your own game, and it survives
being said out loud in a clubhouse. Two practical notes:

- It is **not** a distinctive search term on its own (ojo = a common Spanish
  word, plus an unrelated Nigerian place name). Always market the full string
  **"Ojo Tennis"**, never "Ojo" alone — that's the entity we can realistically
  own, and it's what §5's structured data claims.
- The domain works. When someone reports a certificate warning on it, check
  before changing anything: the cert served by `ojotennis.com` is a valid Let's
  Encrypt one and almost every such report is client-side (an intercepting Wi-Fi
  network, a filtering VPN, or a stale cached DNS answer from before the domain
  was pointed at Vercel).
