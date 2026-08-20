import { config } from "../config";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const CLAY = "#d9662c";
const INK = "#14110d";
const CREAM = "#f4eee4";
const MUTED = "#a89c8a";

/**
 * Shared branded shell for every Ojo email — dark, clay-accented, on-brand with
 * the app. New templates call this so they all look consistent; only the inner
 * body + CTA change.
 */
function layout(opts: { heading: string; bodyHtml: string; ctaLabel?: string; ctaUrl?: string }): string {
  const cta =
    opts.ctaLabel && opts.ctaUrl
      ? `<a href="${opts.ctaUrl}" style="display:inline-block;background:${CLAY};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;margin:8px 0 4px;">${opts.ctaLabel}</a>`
      : "";
  return `<!doctype html><html><body style="margin:0;background:${INK};padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#1c1813;border:1px solid #332c22;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px 28px 8px;">
          <div style="font-size:20px;font-weight:700;color:#fff;letter-spacing:-0.02em;">
            <span style="display:inline-block;width:26px;height:26px;background:${CLAY};border-radius:7px;text-align:center;line-height:26px;font-style:italic;color:${INK};vertical-align:middle;margin-right:8px;">O</span>Ojo Tennis
          </div>
        </td></tr>
        <tr><td style="padding:12px 28px 28px;">
          <h1 style="color:${CREAM};font-size:22px;margin:8px 0 12px;">${opts.heading}</h1>
          <div style="color:${CREAM};font-size:15px;line-height:1.55;">${opts.bodyHtml}</div>
          ${cta}
          <p style="color:${MUTED};font-size:12px;margin-top:24px;">Record, review and share your tennis matches — <a href="${config.appUrl}" style="color:${CLAY};">ojotennis.com</a></p>
        </td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

/**
 * "You were added to a match" — the invite for someone who isn't on Ojo yet.
 *
 * The link carries an invite token, so it works signed-out and the match is
 * connected to whatever account they end up creating. That's deliberate: the old
 * version asked them to sign up "with this email", which quietly failed the
 * moment they used a different address or Google.
 */
export function participantInvite(opts: {
  matchTitle: string;
  inviteUrl: string;
  inviterName?: string | null;
}): RenderedEmail {
  const who = opts.inviterName ? `${escapeHtml(opts.inviterName)} added you` : "You were added";
  const whoText = opts.inviterName ? `${opts.inviterName} added you` : "You were added";
  const subject = opts.inviterName
    ? `${opts.inviterName} added you to a match on Ojo`
    : "You've been added to a match on Ojo";
  const bodyHtml = `<p>${who} as a player in <strong>${escapeHtml(opts.matchTitle)}</strong> on Ojo Tennis.</p>
    <p>Open the link to watch it. You'll be asked to create a free account first — use any email or your Google account, and the match will be waiting in your library either way.</p>`;
  const text = `${whoText} as a player in "${opts.matchTitle}" on Ojo Tennis.

Open this link to watch it: ${opts.inviteUrl}

You'll be asked to create a free account first — any email or your Google account works, and the match will be in your library either way.`;
  return {
    subject,
    html: layout({
      heading: "You're in a match",
      bodyHtml,
      ctaLabel: "Watch the match",
      ctaUrl: opts.inviteUrl,
    }),
    text,
  };
}

/**
 * "You were added to a match" for someone who already has an Ojo account — the
 * match is already in their library, so this is a nudge, not an invitation.
 * Before this, being tagged notified you of precisely nothing.
 */
export function participantAdded(opts: {
  matchTitle: string;
  watchUrl: string;
  inviterName?: string | null;
}): RenderedEmail {
  const who = opts.inviterName ? `${escapeHtml(opts.inviterName)} added you` : "You were added";
  const whoText = opts.inviterName ? `${opts.inviterName} added you` : "You were added";
  const subject = opts.inviterName
    ? `${opts.inviterName} added you to a match on Ojo`
    : "You've been added to a match on Ojo";
  const bodyHtml = `<p>${who} as a player in <strong>${escapeHtml(opts.matchTitle)}</strong>.</p>
    <p>It's already in your library — open it to watch, comment, or run the AI breakdown.</p>`;
  const text = `${whoText} as a player in "${opts.matchTitle}" on Ojo Tennis.

It's already in your library: ${opts.watchUrl}`;
  return {
    subject,
    html: layout({
      heading: "You're in a match",
      bodyHtml,
      ctaLabel: "Watch the match",
      ctaUrl: opts.watchUrl,
    }),
    text,
  };
}

/** Minimal HTML escaping for interpolated user content (titles, names). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
