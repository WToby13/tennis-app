import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "../legal/LegalShell";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "The terms you agree to when using Ojo Tennis, including the rules on objectionable content, reporting and blocking, and the licence for the iPhone app.",
  alternates: { canonical: "/terms" },
};

const CONTACT = "support@ojotennis.com";

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="2026-08-25">
      <p>
        These terms are the agreement between you and Toby Keating, a sole trader based in
        Denmark (&ldquo;we&rdquo;, &ldquo;us&rdquo;), covering the Ojo Tennis iPhone app and
        ojotennis.com. By creating an account you accept them. They are also the end-user licence
        agreement for the app.
      </p>

      <h2>1. Your account</h2>
      <p>
        You must be at least 13 to use Ojo Tennis. Keep your sign-in details to yourself; you are
        responsible for what happens under your account. Give us a real email address, because it is
        how we reach you about your own matches.
      </p>

      <h2>2. Your content stays yours</h2>
      <p>
        You keep every right you have in the matches you record and everything else you post. You
        grant us only the permission we need to run the service: to store your content, process it,
        and show it to the people <em>you</em> have chosen to show it to. That permission ends when
        you delete the content or your account.
      </p>

      <h2>3. Recording other people</h2>
      <p>
        You are responsible for having the agreement of anyone you film before you record them and
        before you share the footage. Do not record where filming is not allowed, and do not upload
        footage of a child who is not yours without their parent&rsquo;s agreement.
      </p>

      <h2>4. Objectionable content: zero tolerance</h2>
      <p>
        There is no tolerance on this service for objectionable content or abusive behaviour. You
        may not upload, post or send:
      </p>
      <ul>
        <li>anything sexual, or any nudity;</li>
        <li>anything that harasses, threatens, bullies or targets a person;</li>
        <li>hate speech, or content attacking people for who they are;</li>
        <li>violence, or content encouraging self-harm;</li>
        <li>anything unlawful, or content you have no right to share;</li>
        <li>footage of someone who has told you not to record or share it;</li>
        <li>spam, scams, or impersonation of another person.</li>
      </ul>
      <p>
        Ojo Tennis is for tennis. Content unrelated to playing tennis may be removed without notice.
      </p>

      <h2>5. Reporting, blocking, and what we do about it</h2>
      <p>
        Every match and every comment carries a <strong>Report</strong> control, and every profile
        carries <strong>Block</strong>. Blocking someone hides their content from you and yours from
        them, immediately, and does not tell them.
      </p>
      <p>
        <strong>We review every report within 24 hours.</strong> Content that breaches section 4 is
        removed, and the account that posted it is suspended or terminated. Serious cases are
        reported to the police. You do not get a warning first.
      </p>
      <p>
        To report something outside the app, email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> with a link to the match or comment.
      </p>

      <h2>6. What we may do</h2>
      <p>
        We may remove content, suspend an account, or end this agreement if these terms are broken.
        We may change or discontinue features. If we discontinue the service entirely we will give
        you reasonable notice and a way to download your matches first.
      </p>

      <h2>7. Price</h2>
      <p>
        Ojo Tennis is currently free to use. If we introduce paid features we will say so clearly
        before you are asked for anything, and nothing you have already uploaded will be put behind
        a paywall.
      </p>

      <h2>8. The service is provided as it is</h2>
      <p>
        We work to keep Ojo Tennis running and your matches safe, but we do not promise it will be
        uninterrupted, error-free, or that a recording will never be lost. Keep your own copy of
        anything you cannot bear to lose. To the extent the law allows, we exclude implied
        warranties, and our total liability to you is limited to the greater of the amount you have
        paid us in the previous twelve months or £50.
      </p>
      <p>
        Nothing in these terms limits liability for death or personal injury caused by negligence,
        for fraud, or for anything else that cannot lawfully be limited. If you are a consumer, your
        statutory rights are unaffected.
      </p>

      <h2>9. Licence for the app</h2>
      <p>
        We grant you a personal, non-transferable, non-exclusive licence to use the Ojo app on Apple
        devices you own or control, as permitted by the App Store Terms of Service. You may not copy
        it (except as the service permits), reverse-engineer it, or redistribute it.
      </p>

      <h2>10. Apple</h2>
      <p>These clauses are required for apps distributed through the App Store:</p>
      <ul>
        <li>
          This agreement is between you and us only. Apple is not a party to it and is not
          responsible for the app or its content.
        </li>
        <li>
          We, not Apple, are solely responsible for the app, its content, maintenance and support.
          Apple has no obligation to furnish any support for it.
        </li>
        <li>
          If the app fails to conform to any applicable warranty, you may notify Apple, and Apple
          will refund the purchase price (which is zero). Apple has no other warranty obligation
          whatsoever, and any other claims are our responsibility.
        </li>
        <li>
          We, not Apple, are responsible for addressing any claim relating to the app: product
          liability, a failure to conform to a legal requirement, and consumer protection or privacy
          claims.
        </li>
        <li>
          We, not Apple, are responsible for investigating and settling any third-party claim that
          the app infringes their intellectual property.
        </li>
        <li>
          You confirm you are not located in a country subject to a US Government embargo or
          designated as terrorist-supporting, and are not on any US Government list of prohibited or
          restricted parties.
        </li>
        <li>
          Apple and its subsidiaries are third-party beneficiaries of these terms and may enforce
          them against you.
        </li>
      </ul>

      <h2>11. Law</h2>
      <p>
        These terms are governed by Danish law, and the Danish courts have jurisdiction. If you
        are a consumer resident in another country, you keep the protection of the mandatory
        consumer-protection rules of the country where you live.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions, complaints, and takedown requests: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>

      <p className="muted">
        See also our <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </LegalShell>
  );
}
