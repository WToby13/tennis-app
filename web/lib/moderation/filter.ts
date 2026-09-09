/**
 * The content filter: text is checked before it is stored, not after.
 *
 * App Store Review Guideline 1.2 asks an app carrying user-generated content for
 * four things. Reporting, blocking and the 24-hour response were already here;
 * this is the first of them — "a method for filtering objectionable content" —
 * and it is the one Ojo was missing when the app was rejected on 8 Sep 2026.
 *
 * Every surface where one player's words reach another goes through `screen`:
 * comments, match titles, participant names and display names. A rejected string
 * is never written, so there is nothing to moderate after the fact.
 *
 * ## Why a term list rather than a model
 *
 * A hosted classifier would catch more, but it fails open on a timeout, costs a
 * round trip on every comment, and cannot be demonstrated to a reviewer in a
 * screen recording without a network. This runs in-process, always returns the
 * same answer for the same input, and is honest about what it is: a floor, not a
 * ceiling. The report queue is what catches everything this misses, which is why
 * both exist.
 *
 * ## Evasion
 *
 * Matching the raw string would be defeated by "f u c k" and "f*ck", so the text
 * is normalised first: case folded, accents stripped, common character
 * substitutions undone, and runs of a repeated letter collapsed.
 *
 * Then two passes, because they have opposite failure modes:
 *
 *  - **Word-boundary** against the normalised text. Safe for short terms — this
 *    is what stops "Scunthorpe" and "classic" being read as something else.
 *  - **Substring** against the same text with every separator removed, which is
 *    what catches "f.u.c.k". Only terms marked `strict` take this pass: they are
 *    long and specific enough that appearing inside an innocent word is not a
 *    thing that happens.
 */

/** Why a string was rejected. Surfaced to the writer, and logged. */
export type ScreenCategory = "hate" | "sexual" | "violence" | "harassment";

export interface ScreenResult {
  ok: boolean;
  /** The category that matched, when it didn't pass. */
  category?: ScreenCategory;
  /** A sentence for the person who typed it. Never names the term they used. */
  message?: string;
}

interface Term {
  word: string;
  category: ScreenCategory;
  /**
   * Also match with separators removed. For terms that cannot appear inside an
   * ordinary word — set it off and you get false positives, so short or
   * substring-prone terms leave it off and rely on the word-boundary pass.
   */
  strict?: boolean;
}

/**
 * The list.
 *
 * Deliberately short and unambiguous. Every entry here is a term whose presence
 * in a tennis app is not a judgement call, which is what makes automatic
 * rejection defensible — a borderline word belongs in the report queue where a
 * person decides, not here where nobody does.
 *
 * Slurs are the bulk of it because they are the category with no legitimate use
 * in this context and the one Apple names first.
 */
const TERMS: Term[] = [
  // Hate: racial, ethnic, religious and anti-LGBTQ slurs.
  { word: "nigger", category: "hate", strict: true },
  { word: "nigga", category: "hate", strict: true },
  { word: "faggot", category: "hate", strict: true },
  { word: "fag", category: "hate" },
  { word: "tranny", category: "hate", strict: true },
  { word: "kike", category: "hate", strict: true },
  { word: "spic", category: "hate" },
  { word: "chink", category: "hate" },
  { word: "wetback", category: "hate", strict: true },
  { word: "paki", category: "hate" },
  { word: "gook", category: "hate" },
  { word: "coon", category: "hate" },
  { word: "retard", category: "hate", strict: true },
  { word: "retarded", category: "hate", strict: true },

  // Sexual content.
  { word: "porn", category: "sexual" },
  { word: "porno", category: "sexual" },
  { word: "pornhub", category: "sexual", strict: true },
  { word: "blowjob", category: "sexual", strict: true },
  { word: "handjob", category: "sexual", strict: true },
  { word: "creampie", category: "sexual", strict: true },
  { word: "cumshot", category: "sexual", strict: true },
  { word: "dildo", category: "sexual", strict: true },
  { word: "pedophile", category: "sexual", strict: true },
  { word: "paedophile", category: "sexual", strict: true },
  { word: "rape", category: "sexual" },
  { word: "rapist", category: "sexual", strict: true },
  { word: "incest", category: "sexual", strict: true },
  { word: "bestiality", category: "sexual", strict: true },

  // Violence and threats.
  { word: "kill yourself", category: "violence", strict: true },
  // Not strict: three letters that fall inside ordinary words once separators
  // are stripped. "kys" on its own is caught; "k y s" spelled out is not, and is
  // left to the report queue rather than bought at the price of false positives.
  { word: "kys", category: "violence" },
  { word: "lynch", category: "violence" },
  { word: "rot in hell", category: "violence", strict: true },

  // Directed harassment. The mildest category, and the reason the queue exists:
  // these are the terms most likely to be a bad joke between two friends who
  // played each other, so only the unambiguous ones are here.
  // Not strict, and the reason the distinction exists: with separators stripped,
  // "Scunthorpe" contains it.
  { word: "cunt", category: "harassment" },
  { word: "whore", category: "harassment", strict: true },
  { word: "slut", category: "harassment", strict: true },
];

/** What the writer is told, per category. */
const MESSAGES: Record<ScreenCategory, string> = {
  hate: "That contains language we don't allow. Please rephrase it.",
  sexual: "That contains sexual content, which isn't allowed here. Please rephrase it.",
  violence: "That reads as a threat, which isn't allowed here. Please rephrase it.",
  harassment: "That contains abusive language. Please rephrase it.",
};

/** Characters people substitute to get past a filter, mapped back. */
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
};

/**
 * Fold the text down to the form the term list is written in.
 *
 * Accents go via NFD so "ñ" and "n" compare equal, and the leet map undoes the
 * obvious character substitutions.
 *
 * Repeated letters are deliberately *not* collapsed here. Collapsing the text
 * without collapsing the terms makes "nigggggger" stop matching "nigger"; doing
 * both makes "coon" collapse to "con", so the innocent word "con" starts
 * matching a slur. Stretched letters are handled in the pattern instead, where
 * one term's spelling cannot leak into another word's.
 */
function normalise(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[0134578@$!|]/g, (c) => LEET[c] ?? c);
}

/** The same text with everything that isn't a letter or digit removed. */
function stripSeparators(normalised: string): string {
  return normalised.replace(/[^a-z0-9]/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A term as a pattern that tolerates stretched letters: "nigger" becomes
 * `n+i+g+g+e+r+`, which matches however many times each letter is repeated
 * without the term list and the text having to be collapsed in step.
 *
 * `spaces` decides what goes between words — whitespace for the word-boundary
 * pass, nothing for the separator-stripped one, where spaces are already gone.
 */
function stretchPattern(word: string, spaces: "\\s+" | ""): string {
  return word
    .split(/\s+/)
    .map((part) =>
      part
        .split("")
        .map((ch) => `${escapeRegExp(ch)}+`)
        .join(""),
    )
    .join(spaces);
}

/** Compiled once — `screen` runs on every comment. */
const COMPILED = TERMS.map((term) => ({
  ...term,
  boundary: new RegExp(`(^|[^a-z0-9])${stretchPattern(term.word, "\\s+")}([^a-z0-9]|$)`),
  collapsed: term.strict ? new RegExp(stretchPattern(term.word, "")) : null,
}));

/**
 * Check one string.
 *
 * Empty and whitespace-only input passes — "is there anything here" is the
 * caller's question to ask, and answering it here would make an empty comment
 * look like an offensive one.
 */
export function screen(input: string): ScreenResult {
  if (!input || !input.trim()) return { ok: true };

  const normalised = normalise(input);
  const collapsed = stripSeparators(normalised);

  for (const term of COMPILED) {
    // Word-boundary pass. \b would not fire either side of a multi-word term's
    // internal space, so the ends are matched against "not alphanumeric" instead.
    if (term.boundary.test(normalised)) {
      return { ok: false, category: term.category, message: MESSAGES[term.category] };
    }

    // Separator-stripped pass, for the terms specific enough to survive it.
    if (term.collapsed?.test(collapsed)) {
      return { ok: false, category: term.category, message: MESSAGES[term.category] };
    }
  }

  return { ok: true };
}

/** True when the string is clean. For callers that only need the verdict. */
export function isClean(input: string): boolean {
  return screen(input).ok;
}
