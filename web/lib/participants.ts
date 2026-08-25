import { track } from "./analytics/server";
import { inviteUrl, sendParticipantAdded, sendParticipantInvites } from "./email/invites";
import type { MetadataStore, Participant, ParticipantInput } from "./metadata";
import { displayNameFor, emailsForUserIds } from "./users";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Parse a client-supplied participant list, dropping anything unusable. */
export function cleanParticipants(raw: unknown): ParticipantInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p: unknown) => {
      const o = (p ?? {}) as Record<string, unknown>;
      const displayName = typeof o.displayName === "string" ? o.displayName.trim() : "";
      const userId = typeof o.userId === "string" && o.userId ? o.userId : null;
      const email =
        typeof o.email === "string" && o.email.trim() ? o.email.trim().toLowerCase() : null;
      return { userId, displayName, email };
    })
    .filter((p) => p.displayName.length > 0);
}

/** A person on the match who hasn't joined yet, and the link that gets them in. */
export interface PendingInvite {
  email: string;
  url: string;
  /**
   * We tried to email them just now and couldn't. The UI surfaces this and
   * offers the link to send by hand — an invite must never depend on the mail
   * provider being healthy.
   */
  failed: boolean;
}

export interface SaveParticipantsResult {
  participants: Participant[];
  /** Everyone still to join, each with a copyable link. */
  invites: PendingInvite[];
}

/**
 * Save a match's players and tell the newcomers about it.
 *
 * One place for this because the recorder (via `uploads/initiate`) and the web
 * editor (via the participants `PUT`) must behave identically — they didn't
 * before, and the difference was invisible until an invite went missing.
 *
 * `set_participants` does the hard part: an address that already belongs to an
 * account is linked outright (so that person needs no invite at all), and the
 * same human named two ways collapses to one row. What's left here is deciding
 * who to email, and handing the caller the invite links so a failed send is
 * recoverable by copying a link rather than a dead end.
 */
export async function saveParticipants(opts: {
  store: MetadataStore;
  supabase: SupabaseClient | null;
  userId: string | null;
  videoId: string;
  matchTitle: string;
  participants: ParticipantInput[];
  /** Who was already on the match, so edits don't re-notify everyone. */
  before: Participant[];
}): Promise<SaveParticipantsResult> {
  const { store, videoId } = opts;

  const knownEmails = new Set(
    opts.before.filter((p) => p.email).map((p) => p.email!.toLowerCase()),
  );
  const knownUserIds = new Set(opts.before.map((p) => p.userId).filter(Boolean) as string[]);

  const participants = await store.setParticipants(videoId, opts.participants);

  const inviterName = opts.supabase ? await displayNameFor(opts.supabase, opts.userId) : null;

  // Pending invites: people with no account yet. Only the newly added ones get
  // an email, but every pending invite comes back with its link so the UI can
  // offer "copy invite link" for any of them.
  const invitesOnMatch = await store.listInvites(videoId).catch(() => []);
  const pending = invitesOnMatch.filter((i) => !i.claimed && i.token);
  const fresh = pending.filter((i) => !knownEmails.has(i.email.toLowerCase()));

  const sent = fresh.length
    ? await sendParticipantInvites({
        invites: fresh.map((i) => ({ email: i.email, token: i.token as string })),
        matchTitle: opts.matchTitle,
        inviterName,
      })
    : [];

  // Newly tagged people who *do* have an account already have the match in their
  // library — this is the notification that used to not exist at all.
  const newlyLinked = participants
    .filter((p) => p.userId && p.userId !== opts.userId && !knownUserIds.has(p.userId))
    .map((p) => p.userId as string);
  if (newlyLinked.length) {
    const emails = await emailsForUserIds(newlyLinked);
    if (emails.length) {
      await sendParticipantAdded({
        videoId,
        matchTitle: opts.matchTitle,
        emails,
        inviterName,
      }).catch(() => {});
    }
  }

  // Naming who you played *is* sharing the match with them — they get it in
  // their library either way — so it counts towards the share rate alongside a
  // link and a post to followers. Tracked here rather than in the two callers so
  // the recorder and the web editor can't drift apart on it, and only when
  // somebody new was actually reached: re-saving an unchanged player list is not
  // a share.
  if (fresh.length || newlyLinked.length) {
    track("match_shared", {
      userId: opts.userId,
      videoId,
      props: { channel: "invite", invited: fresh.length, linked: newlyLinked.length },
    });
  }

  // Every pending invite comes back with its link, including ones emailed on an
  // earlier edit — the inviter may want to chase someone up regardless.
  const failedNow = new Set(sent.filter((r) => !r.sent).map((r) => r.email.toLowerCase()));
  const invites: PendingInvite[] = pending.map((i) => ({
    email: i.email,
    url: inviteUrl(i.token as string),
    failed: failedNow.has(i.email.toLowerCase()),
  }));

  return { participants, invites };
}
