"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { mentionMarkup } from "@/lib/comments";

interface Person {
  id: string;
  displayName: string;
}

/**
 * The `@…` being typed at the caret, if there is one.
 *
 * One space is allowed inside it so "@ada lov" can still find Ada Lovelace; two
 * would swallow the rest of the sentence and turn every following keystroke into
 * a search for a name nobody has. Kept in step with the same rule on iOS
 * (`CommentComposer` in CommentSection.swift).
 */
const TRIGGER_RE = /@([\p{L}\p{N}'’-]{1,30}(?: [\p{L}\p{N}'’-]{1,30})?)$/u;

/**
 * The comment box, with player tagging.
 *
 * What you type is what you see: the field holds `@Ada Lovelace`, not the
 * `@[Ada Lovelace](uuid)` markup that actually goes to the server. The ids of
 * everyone picked are kept alongside and folded back in at post time, so the
 * composer never shows a person a uuid they did not write, and editing the text
 * afterwards cannot leave a half-eaten tag behind — a name that no longer
 * appears simply stops being a mention.
 */
export function MentionComposer({
  onPost,
  busy = false,
  placeholder = "Add a comment…",
  compact = false,
  inputId,
}: {
  onPost: (body: string) => Promise<void> | void;
  busy?: boolean;
  placeholder?: string;
  compact?: boolean;
  inputId?: string;
}) {
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<Person[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Typeahead for the @… at the caret. Two characters is the server's own
  // minimum (see search_users), so anything shorter is not worth a request.
  // `scope=following` because you can only tag someone you follow.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const q = query?.trim() ?? "";
    if (q.length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/users?q=${encodeURIComponent(q)}&scope=following`);
        if (res.ok) {
          setResults(((await res.json()).users ?? []) as Person[]);
          setActive(0);
        }
      } catch {
        /* a failed lookup just means no suggestions */
      }
    }, 200);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  function onChange(value: string) {
    setText(value);
    const caret = inputRef.current?.selectionStart ?? value.length;
    const match = TRIGGER_RE.exec(value.slice(0, caret));
    setQuery(match ? match[1] : null);
  }

  /** Swap the `@…` under the caret for the chosen player's name. */
  function choose(person: Person) {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret);
    const match = TRIGGER_RE.exec(before);
    if (!match) return;
    const head = before.slice(0, before.length - match[0].length);
    const next = `${head}@${person.displayName} ${text.slice(caret)}`;
    setText(next);
    setPicked((p) => (p.some((x) => x.id === person.id) ? p : p.concat(person)));
    setQuery(null);
    setResults([]);
    const at = head.length + person.displayName.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  }

  /**
   * Fold the picked players back into markup. Longest name first, so tagging
   * both "Sam" and "Sam Ellis" cannot leave the longer one rewritten as the
   * shorter one plus stray text.
   */
  function toMarkup(): string {
    let out = text.trim();
    for (const p of [...picked].sort((a, b) => b.displayName.length - a.displayName.length)) {
      out = out.split(`@${p.displayName}`).join(mentionMarkup(p.displayName, p.id));
    }
    return out;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    await onPost(toMarkup());
    setText("");
    setPicked([]);
    setQuery(null);
    setResults([]);
  }

  const open = results.length > 0;

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      // The suggestion list owns Enter while it is open, or picking a name would
      // post the half-typed comment instead.
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape") {
      setQuery(null);
      setResults([]);
    }
  }

  return (
    <form onSubmit={submit} className={compact ? "feed-add mention-wrap" : "comment-form mention-wrap"}>
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setResults([]), 120)}
        disabled={busy}
        autoComplete="off"
      />
      <button className={compact ? "post" : "btn"} type="submit" disabled={busy || !text.trim()}>
        Post
      </button>

      {open && (
        <ul className="mention-menu" role="listbox">
          {results.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                // mousedown, not click: the input's blur would tear the list
                // down before a click ever landed.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <Avatar name={p.displayName} size={24} />
                <span>{p.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}
