import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "../legal/LegalShell";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Ojo Tennis handles your account details and your match recordings: what is stored, who processes it, how long it is kept, and how to delete it.",
  alternates: { canonical: "/privacy" },
};

/** The address in the App Store listing's privacy contact field. Keep them equal. */
const CONTACT = "privacy@ojotennis.com";

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="2026-08-18">
      <p>
        Ojo Tennis is a service for recording, reviewing and sharing your own tennis matches. This
        policy explains what we hold about you, why, and what you can do about it. It covers the Ojo
        iPhone app and ojotennis.com, which are the same service.
      </p>
      <p>
        Ojo Tennis is operated by Toby Keating, a sole trader based in the United Kingdom, who is
        the data controller for the purposes of UK GDPR. Contact: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>What we collect</h2>
      <h3>Account details</h3>
      <p>
        Your email address, the name you give us, and your playing hand. If you sign in with Google
        we receive your email address and name from Google — nothing else, and never your Google
        password.
      </p>

      <h3>Match recordings</h3>
      <p>
        The video you record or upload, a still frame used as its thumbnail, and details you attach:
        the title, the date, and the names of who played. Video is the most sensitive thing here,
        and it is treated as private by default — see <em>Who can see your matches</em> below.
      </p>

      <h3>Things you post</h3>
      <p>
        Comments, likes, who you follow, and any report you file about someone else&rsquo;s content.
      </p>

      <h3>Technical data</h3>
      <p>
        Ordinary server logs from our hosting provider: IP address, timestamps and which pages or
        API endpoints were called. We do not use advertising trackers, we do not sell data, and we
        do not build advertising profiles.
      </p>

      <h2>Why we hold it, and on what basis</h2>
      <ul>
        <li>
          <strong>To run the service</strong> — storing and streaming your matches, signing you in,
          showing your library. Lawful basis: performance of our contract with you.
        </li>
        <li>
          <strong>To produce the AI breakdown</strong>, when you ask for one on a specific match.
          Lawful basis: performance of our contract, on your request.
        </li>
        <li>
          <strong>To keep the service safe</strong> — acting on reports, blocking abuse, preventing
          fraud. Lawful basis: our legitimate interest in a service that is not harmful to use.
        </li>
        <li>
          <strong>To email you</strong> about your own matches and invitations you were sent.
          Lawful basis: performance of our contract.
        </li>
      </ul>

      <h2>Who can see your matches</h2>
      <p>
        Every match is private to you when it is created. It becomes visible to someone else only
        when you do one of these things:
      </p>
      <ul>
        <li>
          <strong>Send a share link.</strong> Anyone holding the link can watch that match. Links
          are unguessable, and you can revoke one at any time, after which it stops working.
        </li>
        <li>
          <strong>Post it to your followers.</strong> It appears in the feed of people who follow
          you.
        </li>
        <li>
          <strong>Name someone as a player.</strong> They can see and manage that match as one of
          its participants.
        </li>
      </ul>
      <p>
        We never make a match public on our own initiative, and search engines are instructed not to
        index match pages.
      </p>

      <h2>Filming other people</h2>
      <p>
        A tennis recording shows an identifiable person who is not you: your opponent. You are
        responsible for having their agreement before you record and before you share the footage.
        Do not record people who have asked you not to, do not record in a place where filming is
        prohibited, and do not record anyone under 18 who is not your own child without their
        parent&rsquo;s agreement. If you appear in someone else&rsquo;s match and want it taken
        down, email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will remove it.
      </p>

      <h2>Who processes your data for us</h2>
      <p>These are the only third parties that touch your data, and each is a processor acting on our instructions:</p>
      <ul>
        <li>
          <strong>Supabase</strong> — accounts, sign-in, and all match metadata (EU region).
        </li>
        <li>
          <strong>Amazon Web Services</strong> — video and thumbnail storage (S3) and delivery
          (CloudFront), in the <code>eu-west-1</code> region (Ireland). Stored objects are private
          and can only be fetched through short-lived signed URLs.
        </li>
        <li>
          <strong>Vercel</strong> — application hosting.
        </li>
        <li>
          <strong>TwelveLabs</strong> — the AI rally breakdown. A match is sent to TwelveLabs
          <em> only when you ask for a breakdown of it</em>, and only for as long as the analysis
          takes. If you never request a breakdown, your video is never sent there.
        </li>
        <li>
          <strong>Resend</strong> — sending transactional email.
        </li>
        <li>
          <strong>Google</strong> — only if you choose to sign in with Google.
        </li>
      </ul>
      <p>
        Some of these operate outside the UK/EEA. Where they do, transfers rely on the UK
        International Data Transfer Addendum and the EU Standard Contractual Clauses.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          <strong>Matches</strong> — until you delete them. Deleting a match removes its video and
          thumbnail from storage; it is not recoverable afterwards.
        </li>
        <li>
          <strong>Account data</strong> — until you delete your account.
        </li>
        <li>
          <strong>Analysis copies</strong> — a temporary downscaled copy is made for a long match so
          it fits the analysis service&rsquo;s limits, and is deleted within 48 hours.
        </li>
        <li>
          <strong>Content reports</strong> — kept after the reported content is gone, because a
          report has to stay actionable against the account. Retained for two years.
        </li>
        <li>
          <strong>Server logs</strong> — retained by our hosting provider on their standard schedule
          (currently around 30 days).
        </li>
      </ul>

      <h2>Deleting your account</h2>
      <p>
        You can delete your account and everything in it from inside the app: <strong>You →
        Settings → Delete account</strong>, or on the web from your profile page. This removes your
        matches and their video files, your comments, likes, follows and profile. It happens
        immediately and cannot be undone. If you would rather we did it, email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <h2>Your rights</h2>
      <p>
        Under UK GDPR you can ask us for a copy of your data, ask us to correct it, ask us to delete
        it, ask us to restrict or stop a particular use, and ask for it in a portable format. Email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will respond within one month. If you are
        not satisfied, you can complain to the Information Commissioner&rsquo;s Office at{" "}
        <a href="https://ico.org.uk" rel="noopener noreferrer" target="_blank">
          ico.org.uk
        </a>
        .
      </p>

      <h2>Children</h2>
      <p>
        Ojo Tennis is not intended for children under 13, and you may not create an account if you
        are under 13. If we learn that we hold data about a child under 13 we will delete it.
      </p>

      <h2>Security</h2>
      <p>
        Traffic is encrypted in transit. Video files are stored in a private bucket that is not
        publicly readable, and playback goes through signed URLs that expire. Access to the
        underlying database is restricted per user by row-level security, so one account cannot read
        another&rsquo;s matches. No system is perfect, and we do not claim otherwise.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes materially we will say so in the app before the change takes effect.
        The date at the top always reflects the current version.
      </p>

      <p className="muted">
        See also our <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalShell>
  );
}
