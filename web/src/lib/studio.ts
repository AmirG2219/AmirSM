export const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];

export const extOf = (n: string) => {
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i).toLowerCase();
};

/** Short example descriptions: shown as placeholders and as tap-to-fill chips. */
export const EXAMPLES: { label: string; text: string }[] = [
  { label: 'Day in the life', text: 'A relaxed day in my life: wake up, coffee, a walk, then work. Quick, friendly cuts and a title that says "Day in my life".' },
  { label: 'Calm cinematic', text: 'A slow, calm, cinematic edit of my morning. Soft transitions, warm look, nothing rushed.' },
  { label: 'Motivation', text: 'A motivational video. Start with my strongest shot, punchy cuts, and the on-screen text "Keep going".' },
  { label: 'Driving', text: 'A night drive. Smooth cuts, moody look, open with the road ahead and end on the city lights.' },
  { label: 'Eating', text: 'A cozy food video: close-ups of the meal first, then the table. Warm and bright, relaxed pace.' },
  { label: 'Soccer', text: 'My soccer match highlights. Fast cuts on the best moments, high energy, finish on the celebration.' },
];

/** A readable project title: the first sentence of the description (shortened at a word boundary), or a dated fallback. */
export function titleFromDescription(text: string): string {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? '';
  const clean = firstLine.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? '';
  let words = first.replace(/[.,;:!?]+$/, '').split(' ').filter(Boolean);
  if (first.length > 48) words = words.slice(0, 5);
  const dangling = new Set(['a', 'an', 'the', 'with', 'and', 'of', 'to', 'in', 'on', 'for', 'at', 'my', 'then', 'but']);
  while (words.length > 2 && dangling.has(words[words.length - 1]!.toLowerCase())) words.pop();
  const t = words.join(' ');
  if (t.length >= 3) return (t[0]!.toUpperCase() + t.slice(1)).slice(0, 60);
  return `Video · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
