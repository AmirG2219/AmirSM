/**
 * Thread grouping rules (pure helpers; the DB side lives in cache.ts). In order of trust:
 *  1. the server's own thread id (Gmail X-GM-THRID / JMAP-style THREADID) when it provides one,
 *  2. Message-ID / In-Reply-To / References links (in both directions, so a reply that is synced before its parent still joins),
 *  3. same normalised subject, but ONLY for messages that carry a reply/forward prefix ("Re:", "Fwd:" ...) and fall within
 *     30 days of the thread — so two unrelated "Hello" mails are never merged just because the subject matches.
 */

const PREFIX_RE = /^\s*(?:re|fwd?|fw|aw|wg|sv|vs|antw|r|tr|rv|enc|res)(?:\[\d+\])?\s*:\s*/i;
const MAX_STRIP = 12;

export function hasReplyPrefix(subject: string): boolean {
  return PREFIX_RE.test(subject);
}

/** lower-case subject without any number of leading Re:/Fwd: style prefixes and extra spaces */
export function normalizeSubject(subject: string): string {
  let s = subject.normalize('NFKC');
  for (let i = 0; i < MAX_STRIP && PREFIX_RE.test(s); i++) s = s.replace(PREFIX_RE, '');
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** "Re: x" for replies, without stacking prefixes ("Re: Re: x" never happens). */
export function replySubject(subject: string): string {
  const base = subject.trim();
  return /^\s*re(?:\[\d+\])?\s*:/i.test(base) ? base : `Re: ${base || '(no subject)'}`;
}

/** Fallback window for subject-only matching. */
export const SUBJECT_MATCH_WINDOW_MS = 30 * 24 * 3_600_000;

/** In-Reply-To + References headers for a reply to a message with these ids (RFC 5322 3.6.4), bounded in length. */
export function replyHeaders(parent: { messageId: string; references: string[] }): { inReplyTo: string; references: string[] } {
  const refs = [...parent.references.filter((r) => r !== parent.messageId), parent.messageId].slice(-10);
  return { inReplyTo: `<${parent.messageId}>`, references: refs.map((r) => `<${r}>`) };
}
