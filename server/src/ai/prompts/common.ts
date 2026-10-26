/** Wrap untrusted/owner text in a fenced tag; neutralise attempts to close the tag early. */
export function fence(tag: string, text: string): string {
  const safe = text.replace(new RegExp(`</\\s*${tag}`, 'gi'), `<\\/${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} characters]`;
}

/** Shown when at least one clip has a visual analysis: the model still has not watched the video. */
export const PARTIAL_VISION_NOTICE =
  'You have NOT watched the video and you cannot hear it. For some clips a <clip_analysis> block tells you what a vision model saw in a few sampled still frames (VISUAL) and/or what signal measurements found (TECHNICAL). Rely on those statements only for the clips and timestamps they cover, remember that stills are samples (no motion, no sound), and know nothing about the content of clips without a VISUAL entry. Never describe what happens in the footage beyond that, and never invent events, places, people, products, results or claims.';

export const NO_VISION_NOTICE =
  'You cannot see or hear the video. You only know what the owner wrote and the technical facts (names, durations, sizes, audio present or not). Never describe what happens in the footage, and never invent events, places, people, products, results or claims.';
