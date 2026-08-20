# Publishing Ojo Tennis to the App Store

Written 2026-08-18, when the app was renamed from "Ojo Dev" and prepared for
submission. Everything in §2 is already done in the repo; §3 onward is work only
you can do, because it needs your Apple ID, your card and your name.

Realistic timeline: **half a day of your time, plus 1–3 days of Apple's.** The
enrolment is the slow, unpredictable part — start it first and do everything
else while it processes.

---

## 1. What the app is now

| | |
|---|---|
| App Store name | **Ojo Tennis** |
| Home-screen name | **Ojo** |
| Bundle id | **`com.ojotennis.app`** — permanent once published, cannot ever be changed |
| Version / build | 1.0 (1) |
| Minimum iOS | 17.0 |
| Devices | iPhone only |
| Xcode project | `ios/Ojo/Ojo.xcodeproj` |
| Team id | `2HZJ6DQYLM` |

The old `ios/TennisRecorder/` project is deleted (it's in git history). There is
one project now, and it is the one that was called "Ojo Dev".

---

## 2. What's already been done

- **Renamed** end to end: project, target, scheme, app struct, background
  `URLSession` id and logging subsystem. Nothing still says "TennisRecorder".
- **Bundle id** set to `com.ojotennis.app`; display name "Ojo".
- **Deployment target dropped 26.5 → 17.0.** It was set to the newest possible
  iOS, which would have made the app installable by almost nobody. Builds clean
  at 17.0.
- **iPhone only**, and visionOS/macOS dropped from `SUPPORTED_PLATFORMS`. This
  means you don't have to produce iPad screenshots or defend iPad layout in
  review.
- **App icon flattened.** It carried an alpha channel; App Store Connect rejects
  icons with transparency at upload, before review even starts.
- **Export compliance declared** (`ITSAppUsesNonExemptEncryption=false`), so
  every build skips the encryption question instead of stalling on it.
- **Account deletion** — Settings → Delete account, wired to
  `DELETE /api/users/me`, which purges the video files then deletes the auth
  user (cascading every row). Required by Guideline 5.1.1(v).
- **Report and block** — on feed cards, the watch screen, every comment and
  every profile; plus a blocked-accounts list you can undo from. Backed by
  migration `0014_moderation.sql`. Required by Guideline 1.2.
- **Privacy Policy** (`/privacy`) and **Terms/EULA** (`/terms`), public, linked
  from the landing footer, the iOS sign-up screen and iOS Settings. The terms
  carry the seven Apple-required clauses and the zero-tolerance section 1.2
  wants to see.

- **Verified against the rest of the session's work.** Other agents landed the
  invite/participant rework (`0015_invites.sql`) alongside this. The full
  migration chain, both SQL test suites, the web build and a Release iOS build
  were run together — see §2.1.

**Not done, and it needs you:** run migrations `0014` and `0015`, set
`MODERATION_EMAIL`, and have a lawyer glance at the two legal documents. See §3.

### 2.1 What the merge check found

Worth knowing, because two of these were live bugs:

| Found | Fix |
|---|---|
| `0014_moderation.sql` would not apply: it rebased `get_feed` on **0007**, dropping the `in_library` column **0008** added. Forced through with a DROP it would have applied cleanly and silently broken "add to profile" on every feed card. | 0014 now matches 0008's return type; `moderation_test.sql` asserts the column survives. |
| Account deletion left the deleted person's **name and email on other people's matches** — `video_participants.user_id` is ON DELETE SET NULL, so the row survives the cascade. Contradicted the privacy policy. | `DELETE /api/users/me` now anonymises those rows before deleting the user. The participant slot stays, so the match still records that two people played. |
| `/invite/<token>` rendered inside the signed-in app sidebar for a logged-out recipient — the highest-intent page in the funnel. | `/invite` added to `Shell.tsx`'s public prefixes. |
| **Settings was unreachable in the app**, so Delete account and Blocked accounts could not be opened at all — an automatic 5.1.1(v) rejection. The gear had been put on `ProfileView`, which is only ever pushed for *other* players; the You tab renders `LibraryView`. Found by running the app, not by reading it. | Gear moved to `LibraryView`'s toolbar and the misleading self-tab branch deleted from `ProfileView`. Verified on the simulator: You → gear → Delete account, and the blocked list loads against production. |

The two suites live in `supabase/tests/` and run offline against a scratch
Postgres: `supabase/tests/run.sh`.

---

## 3. Before you touch App Store Connect

### 3.1 Run the outstanding migrations

Supabase → SQL Editor → run **in this order**:

1. `supabase/migrations/0014_moderation.sql` — blocks and content reports.
2. `supabase/migrations/0015_invites.sql` — the participant/invite rework.

Without 0014, every Report and Block button in the app 500s, which is a
guaranteed rejection because a reviewer *will* press them.

Verify afterwards:

```sql
select count(*) from public.user_blocks;      -- expect 0, not an error
select count(*) from public.content_reports;
select pg_get_function_result('public.get_feed'::regproc) ~ 'in_library';  -- expect t
```

The whole chain plus both test suites can be rehearsed offline first — see
`supabase/tests/run.sh`. That is worth doing before touching production.

### 3.2 Set the moderation email

Vercel → project → Settings → Environment Variables → add
`MODERATION_EMAIL=tobykeating13@gmail.com` (or a dedicated address), then
redeploy. Reports are written to the database regardless, but this is what
actually tells you one arrived — and the listing promises action within 24
hours.

### 3.3 Point the support addresses somewhere real

The legal pages and the app reference `support@ojotennis.com` and
`privacy@ojotennis.com`. **Right now both bounce** — the domain has no `MX`
record, so nothing accepts mail for it. A reviewer occasionally emails the
support address, and a bounce is a rejection.

Forwarding is built and committed (`/api/inbound`), but it needs an `MX` record,
a full-access Resend key and three Vercel env vars before it does anything.
Six steps, about fifteen minutes: **[`docs/EMAIL.md`](EMAIL.md) → Receiving mail**.

### 3.4 Get the legal documents looked at

`/privacy` and `/terms` are written to be accurate about what this app actually
does, and they satisfy Apple's structural requirements. They are not legal
advice and I am not a lawyer. You are storing video of identifiable people under
UK GDPR — an hour of a solicitor's time before launch is cheap insurance.

### 3.5 Deploy

Push to `main`. Confirm `https://ojotennis.com/privacy` and `/terms` load in a
private window with no session. They must be reachable without signing in —
review checks the privacy URL before it has an account.

---

## 4. Enrol in the Apple Developer Program

**$99 / £79 a year.** This is the purchase you asked about. Start it now; the
rest of §5 onward can be done while it processes.

1. Go to <https://developer.apple.com/programs/enroll/>.
2. Sign in with the Apple ID you want to *own the app forever*. Use a personal
   Apple ID you control, with two-factor already turned on. Changing the owning
   account later is painful.
3. Choose entity type:
   - **Individual / Sole Proprietor** — fastest, usually approved in 24–48 h.
     Your apps are listed under **your own legal name**, publicly, as the seller.
   - **Organization** — lists a company name instead, but needs a legal entity
     and a **D-U-N-S number**, which takes 5–14 days to obtain on its own.

   **Recommendation: enrol as an Individual.** You are a sole trader, the legal
   documents already say so, and waiting two weeks for a D-U-N-S number to
   change the displayed seller name is not worth it at this stage. You can
   migrate to an Organization account later.
4. Confirm your name and address exactly as they appear on your ID.
5. Pay the $99 with a card. It auto-renews annually; you get a reminder.
6. Wait for the "Welcome to the Apple Developer Program" email. If it stalls
   past 48 hours, phone Apple Developer Support — it is nearly always an
   identity check they need you to confirm verbally.

Once approved, in Xcode: **Settings → Accounts → +** and sign in with that Apple
ID, so the team appears in the signing dropdown.

---

## 5. Create the app record

App Store Connect → <https://appstoreconnect.apple.com> → **Apps → +**.

| Field | Value |
|---|---|
| Platform | iOS |
| Name | `Ojo Tennis` |
| Primary language | English (UK) |
| Bundle ID | `com.ojotennis.app` — register it first at Certificates, IDs & Profiles → Identifiers if it isn't in the dropdown |
| SKU | `ojo-tennis-ios` (internal only, never shown) |
| User access | Full |

If **"Ojo Tennis" is taken**, the name is reserved by someone else and you
cannot use it. Fallbacks that keep the brand: `Ojo Tennis — Match Video`,
`Ojo: Watch Your Tennis`. The bundle id doesn't change either way.

---

## 6. Fill in the listing

### Subtitle (30 characters)
> `Watch your match back`

### Promotional text (170 chars, changeable without a new build)
> Record your whole match from the back of the court, then watch every point
> back in slow motion — and send it to whoever you played.

### Description
Lead with the definitional sentence; it's what search and AI summaries lift.

```
Ojo Tennis records your whole match from an iPhone at the back of the court,
then lets you review every point in slow motion and share the ones that
mattered.

Most club players have never once seen themselves play. Not because it's
expensive or difficult — but because filming a match produces a two-hour, 4 GB
file with no way to find anything in it, sitting in a camera roll nobody opens.

Ojo fixes the three things that make that useless:

PROP YOUR PHONE AND PRESS RECORD
Landscape, behind the baseline, roughly fence height. No tripod rig, no
court-mounted camera, no subscription to a box on a pole. The phone in your bag
is the whole setup.

THE UPLOAD SURVIVES CLUB WI-FI
Matches upload in chunks in the background, so a dropped connection doesn't cost
you the file. Long matches are compressed rather than refused.

THE POINTS, FOUND FOR YOU
Ojo's AI breakdown marks where each rally starts and ends and groups them into
service games, so you jump point to point instead of scrubbing past the
ball-collecting.

BUILT FOR REVIEW, NOT WATCHING
Frame-step, variable speed, and a scrubber that lands where you drop it. The
difference between "I lost that point" and seeing your toss drift behind your
head.

BOTH PLAYERS GET THE FOOTAGE
Send the match to the person on the other side of the net. They open the link,
watch it, and add it to their own library in a tap.

PRIVATE UNTIL YOU DECIDE
Every match is yours alone by default. Share a private link, post it to the
players who follow you, or share nothing. Links can be revoked.

Free to use.
```

### Keywords (100 characters, comma-separated, no spaces)
> `tennis,match,video,record,coaching,review,slow motion,rally,serve,analysis,club,court,footage`

### URLs
- Support URL: `https://ojotennis.com/landing`
- Marketing URL: `https://ojotennis.com/landing`
- **Privacy Policy URL: `https://ojotennis.com/privacy`** (required)

### Category
Primary **Sports**, secondary **Photo & Video**.

### Age rating
Answer the questionnaire honestly. The one that matters: **"Does your app
contain user-generated content?" → Yes.** Saying no when the app has a feed and
comments is the fastest route to a rejection you can't argue with. Expect a
**12+** rating as a result, which is fine.

---

## 7. Screenshots

Required: **6.9" iPhone** (1290×2796 or 1320×2868). One set covers every iPhone
size now — you do not need the older sizes.

Between 3 and 10 images. Capture them from a real device or the iPhone 17 Pro
simulator (`Cmd+S` in Simulator saves to Desktop), with a real match loaded, not
an empty state.

Suggested five, in order:

1. **The review player**, mid-rally, controls visible — this is the product.
2. **The rally breakdown timeline**, showing service games. The differentiator.
3. **The match library**, several matches with thumbnails and status chips.
4. **Recording**, camera view with the record control.
5. **A shared match** on the watch screen.

Use matches of yourself, or of someone who has agreed to appear in App Store
screenshots.

---

## 8. App Privacy (the nutrition label)

App Store Connect → your app → **App Privacy**. Answer from what the app
actually does — `/privacy` is the source of truth, and a mismatch between the
two is something reviewers do check.

Apple asks three things about every data type you tick: **what it's used for**,
**whether it's linked to the user's identity**, and **whether it's used for
tracking**. For this app the last two are the same every time — linked **Yes**
(it all hangs off an account), tracking **No** — and the purpose is always **App
Functionality** alone. Do not tick Analytics or Product Personalisation: there
is no analytics SDK in either client, so ticking it would be a false statement
on the label.

**Tick these five. Purpose: App Functionality. Linked: Yes. Tracking: No.**

| Apple's category | Data type | What it actually is |
|---|---|---|
| Contact Info | **Name** | The name on the profile, shown to other players |
| Contact Info | **Email Address** | Sign-in identity; also how an invite is addressed |
| User Content | **Photos or Videos** | The match recording, and its thumbnail frame |
| User Content | **Audio Data** | Match audio — the recording captures the microphone |
| User Content | **Other User Content** | Comments, match titles, participant names, report details |
| Identifiers | **User ID** | The Supabase account id |

**Audio Data is the one most people miss.** It looks like it's covered by
"Photos or Videos", but the app asks for microphone permission and records
sound into the file, so it is its own declaration. Over-declaring costs you a
line on the label; under-declaring is a mismatch with the Info.plist permission
strings, which is the kind of thing review does notice.

**Leave everything else unticked**, in particular:

| Not collected | Why it's safe to say no |
|---|---|
| Usage Data, Analytics | No analytics SDK anywhere — verified in both clients |
| Diagnostics / Crash Data | No crash reporter. `UploadLog` writes to the device's own log and a capped local file, and never transmits |
| Device ID, Advertising Data | No ad SDK, no IDFA, no `AdSupport` |
| Location | Never requested |
| Search History | People-search queries are sent to be answered and not stored |
| Health & Fitness | It is a tennis app, but it records no health data |
| Purchases, Financial Info | Nothing is sold in the app |

**"Do you or your third-party partners use data for tracking?" → No.** No ad
SDK and no cross-app tracking, so you do not need App Tracking Transparency and
should not add the prompt.

**A judgement call, so you can decide it rather than discover it.** Your host
(Vercel) writes ordinary server logs containing IP addresses, and the privacy
policy says so. Apple's label covers data the *app* collects, and operational
logs used for nothing but running the service are conventionally not declared.
Declaring nothing here is the normal reading and what I would do — but it is a
judgement, not a certainty, and the policy already discloses it in plain words,
which is what actually matters legally.

**Third parties who receive this data** (worth having straight, because it is
the question that follows a privacy complaint): Supabase holds the account and
metadata; AWS S3/CloudFront holds the video; Vercel serves the app; Resend
sends invite email; Google is the OAuth provider if the user chooses it; and
**TwelveLabs receives the video itself** when an AI breakdown is run. That last
one is the most sensitive relationship you have, and `/privacy` names it.

---

## 9. Archive and upload

In Xcode, with `ios/Ojo/Ojo.xcodeproj` open:

1. Target **Ojo** → **Signing & Capabilities** → tick *Automatically manage
   signing*, pick your Team. Xcode creates the App ID and distribution
   certificate for you.
2. Destination: **Any iOS Device (arm64)**. Not a simulator — you cannot archive
   for the store from a simulator destination.
3. **Product → Archive**.
4. In the Organizer that opens: **Distribute App → App Store Connect → Upload**,
   accept the defaults (including symbol upload), and sign.
5. Wait ~10 minutes for processing, then the build appears under **TestFlight**
   in App Store Connect.

If the upload is rejected immediately, it's almost always one of: an icon with
transparency (fixed), a missing usage-description string (present), or a bundle
id that isn't registered (§5).

---

## 10. TestFlight first

Do not go straight to review. Under **TestFlight → Internal Testing**, add
yourself and a handful of the players you actually hit with, and use it for a
week. Internal testing needs no Beta App Review, so it's available within
minutes of processing.

What to exercise, because these are the paths the Simulator could not verify:

- **A full-length real match upload over club Wi-Fi**, including backgrounding
  the app and relaunching mid-upload. This is the single least-tested path in
  the app.
- **The AI breakdown** on a two-hour match, end to end.
- **Report, Block, and the blocked list** — every one of them hits new server
  routes for the first time.
- **Delete account**, on a throwaway account. Verify the matches and the S3
  objects are actually gone, not just hidden.
- Sign in with Google, and the `ojo://` redirect back into the app.

---

## 11. Submit for review

**Prepare for Submission** → attach the build → fill in **App Review
Information**:

- **Sign-in required: Yes.** Create a demo account with two or three real
  matches already uploaded and analysed, and put its email and password in the
  demo-account fields. A reviewer who lands on an empty account rejects for
  "incomplete app" more often than for anything else.

  Concretely, before you submit:

  1. Make the demo account and sign in as it on the web.
  2. Put **three matches** in its library, at least one with a finished AI
     breakdown — that is the screen the product is actually about, and an
     analysis run takes minutes, so it cannot be done during review.
  3. Make a **second** account, have it follow the demo account and post a match
     to followers, so the demo account's Home feed is not empty. An empty feed
     is where a reviewer goes looking for the moderation tools and fails to find
     them, because the ⋯ menu lives on a feed card.
  4. Leave a comment from the second account, so there is a comment to report
     that is not the reviewer's own.
  5. Check the demo password has no characters that are awkward to type on a
     locked-down review device, and that it does not expire.
- **Contact:** your name, phone, and an email you'll read within a day.
- **Notes** — write something like:

  > Ojo Tennis records a tennis match on an iPhone and lets you review it in
  > slow motion and share it with the person you played.
  >
  > The demo account has three matches already uploaded, including one with a
  > completed AI rally breakdown, so nothing has to be recorded or uploaded to
  > see the app working.
  >
  > User-generated content (Guideline 1.2): matches can be posted to followers
  > and commented on. Reporting is on the ⋯ menu of every feed card, on the
  > watch screen, and on every comment. Blocking is on the same menu and on each
  > profile; blocked accounts are listed and reversible under You → Settings →
  > Blocked accounts. Reports go to a moderation queue and are reviewed within
  > 24 hours; the rules are published at https://ojotennis.com/terms.
  >
  > Blocking is thorough rather than cosmetic: a blocked account disappears from
  > the feed, from comments, and from people search (the magnifying glass beside
  > the Home title) in both directions — the blocked person cannot find the
  > blocker either. The second demo account below can be used to try this.
  >
  > Accepting the terms and the zero-tolerance policy is part of creating an
  > account — the text is on the sign-up screen above the Create account button.
  >
  > Account deletion (5.1.1(v)): You → Settings (gear icon) → Delete account.
  > This deletes the account, every match and the underlying video files.
  >
  > Recording uses the camera and microphone. Video is stored privately and is
  > only visible to people the user explicitly shares with.

- **Version release:** "Manually release this version" for a first launch, so
  you control the moment it goes live.

Then **Add for Review → Submit**. First reviews typically land within 24–48
hours.

---

## 12. If it comes back rejected

Rejection on a first submission is normal, not a verdict. Reply in Resolution
Center — do not resubmit silently. The likely ones, in order:

| Rejection | What it means | Fix |
|---|---|---|
| **2.1 Performance — incomplete** | Reviewer saw an empty app | The demo account had no matches, or the upload failed on their network. Load it up and reply with specifics. |
| **1.2 Safety — UGC** | They didn't find report/block | Reply pointing at the exact taps (§11 notes). Everything they want exists. |
| **5.1.1(v) Account deletion** | They didn't find it | Reply with the path: You → gear icon → Delete account. |
| **4.8 Sign in with Apple** | Google login without an equivalent | See below. |
| **5.1.1 Privacy — data collection** | Nutrition label doesn't match reality | Re-check §8 against `/privacy`. |

### The 4.8 risk, honestly

The app offers Google sign-in. Guideline 4.8 requires that an app using a
third-party login also offers an equivalent option that limits data collection
to name and email, lets the user keep their email private, and doesn't track.
Ojo also offers plain email + password, which most reviewers accept as that
equivalent — but not all do, because a first-party email signup can't hide the
user's email address the way Sign in with Apple can.

**Don't pre-emptively build Sign in with Apple.** Submit as-is. If 4.8 comes
back, adding it is roughly a day: enable the capability in Xcode, turn on the
Apple provider in Supabase (which already supports it), and add an
`ASAuthorizationAppleIDButton` to `LoginView`. Doing it reactively costs one
review cycle; doing it speculatively costs a day you might not need to spend.

---

## 13. After it's live

- **Turn off the sign-in wall on shared links.** It is still the biggest
  conversion loss in the funnel — see blocker #2 in [`GTM.md`](GTM.md). Getting
  the app approved doesn't change that.
- **Watch the moderation inbox.** You've now published a 24-hour commitment.
- **Add analytics** (blocker #4). You cannot tell whether the launch worked
  without the four numbers in `GTM.md` §6.
- **Don't buy App Store ads.** `GTM.md` §3 is right about this — the loop is
  the growth mechanic, and it's player-to-player, not search.
- Renew the $99 each year, or the app is removed from sale.
