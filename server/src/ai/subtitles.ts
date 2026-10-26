/** Helpers that guarantee subtitles only ever contain text the owner supplied. */
import type { Subtitles } from '../../../shared/editPlan.js';

export const MAX_CUE_CHARS = 160;
export const MAX_CUES = 200;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Trim, drop empties, split lines longer than a cue allows (at word boundaries). */
export function cleanUserLines(lines: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of lines ?? []) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.length <= MAX_CUE_CHARS) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > MAX_CUE_CHARS) {
      let cut = rest.lastIndexOf(' ', MAX_CUE_CHARS);
      if (cut < 40) cut = MAX_CUE_CHARS;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** A cue is traceable when its text is (part of) what the owner supplied. */
export function makeTraceabilityCheck(userLines: string[] | undefined): (cueText: string) => boolean {
  const joined = normalizeText(cleanUserLines(userLines).join(' '));
  return (cueText: string) => {
    const n = normalizeText(cueText);
    return n.length > 0 && joined.length > 0 && joined.includes(n);
  };
}

/** Spread the owner's lines evenly over the output timeline (timings are NOT speech-synced). */
export function evenCues(lines: string[], totalMs: number): Subtitles['cues'] {
  const cleaned = cleanUserLines(lines).slice(0, MAX_CUES);
  if (cleaned.length === 0 || totalMs <= 0) return [];
  const n = cleaned.length;
  const cues: Subtitles['cues'] = [];
  cleaned.forEach((text, i) => {
    const startMs = Math.floor((i * totalMs) / n);
    const endMs = Math.max(startMs + 1, Math.floor(((i + 1) * totalMs) / n));
    cues.push({ startMs, endMs, text });
  });
  return cues;
}
