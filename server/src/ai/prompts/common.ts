/** Wrap untrusted/owner text in a fenced tag; neutralise attempts to close the tag early. */
export function fence(tag: string, text: string): string {
  const safe = text.replace(new RegExp(`</\\s*${tag}`, 'gi'), `<\\/${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} characters]`;
}

export const NO_VISION_NOTICE =
  'You cannot see or hear the video. You only know what the owner wrote and the technical facts (names, durations, sizes, audio present or not). Never describe what happens in the footage, and never invent events, places, people, products, results or claims.';
