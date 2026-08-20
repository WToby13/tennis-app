"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";

interface Invite {
  videoId: string;
  matchTitle: string;
  invitedName: string;
  invitedEmail: string | null;
  inviterName: string | null;
  claimed: boolean;
}

/**
 * The landing page for an emailed match invite.
 *
 * This is the piece the old flow was missing. An invite used to point at
 * `/watch/<id>`, which bounced a signed-out recipient to the sign-in page with
 * no explanation, and only connected them to the match if they happened to sign
 * up with the exact address it was sent to. Here the token does the work: we
 * show what they've been invited to first, send them to sign-up with their
 * address prefilled, and then claim the invite for whatever account they came
 * back with.
 */
export default function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();

  const [invite, setInvite] = useState<Invite | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const claim = useCallback(async () => {
    const res = await fetch(`/api/invites/${token}`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error ?? "Couldn't open this invite");
      return;
    }
    const { videoId } = await res.json();
    router.replace(`/watch/${videoId}`);
  }, [router, token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/invites/${token}`);
        if (!res.ok) {
          if (!cancelled) setError("This invite link is no longer valid.");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setInvite(data.invite);
        setSignedIn(Boolean(data.signedIn));
        // Already signed in — nothing to ask, just put the match in their library
        // and show it.
        if (data.signedIn) await claim();
      } catch {
        if (!cancelled) setError("Couldn't load this invite.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [claim, token]);

  // Carry the invite through auth, plus the address it was sent to so the
  // sign-up form starts filled in.
  const next = encodeURIComponent(`/invite/${token}`);
  const emailParam = invite?.invitedEmail
    ? `&email=${encodeURIComponent(invite.invitedEmail)}`
    : "";

  if (loading || (signedIn && !error)) {
    return (
      <div className="auth-wrap">
        <p className="muted" style={{ textAlign: "center" }}>
          Opening your invite…
        </p>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="Ojo Tennis" width={60} height={60} style={{ borderRadius: 14 }} />
      </div>

      {error || !invite ? (
        <>
          <h1 style={{ textAlign: "center" }}>Invite not available</h1>
          <div className="card" style={{ padding: 24, marginTop: 16 }}>
            <p className="muted" style={{ marginTop: 0 }}>
              {error ?? "This invite link is no longer valid."}
            </p>
            <p className="muted" style={{ fontSize: 14 }}>
              Ask whoever recorded the match to send you a fresh link.
            </p>
            <Link className="btn secondary" href="/sign-in" style={{ marginTop: 8 }}>
              Sign in
            </Link>
          </div>
        </>
      ) : (
        <>
          <h1 style={{ textAlign: "center" }}>
            {invite.inviterName ? `${invite.inviterName} added you to a match` : "You're in a match"}
          </h1>
          <div className="card" style={{ padding: 24, marginTop: 16 }}>
            <p style={{ marginTop: 0, fontSize: 18, fontWeight: 600 }}>{invite.matchTitle}</p>
            <p className="muted" style={{ fontSize: 14 }}>
              Create your free account to watch it. It'll be waiting in your library, along with
              any other matches you're tagged in.
            </p>
            <Link className="btn" href={`/sign-up?next=${next}${emailParam}`} style={{ width: "100%", justifyContent: "center" }}>
              Create account
            </Link>
            <p className="auth-alt muted" style={{ marginBottom: 0 }}>
              Already on Ojo? <Link href={`/sign-in?next=${next}${emailParam}`}>Sign in</Link>
            </p>
          </div>
        </>
      )}
    </div>
  );
}
