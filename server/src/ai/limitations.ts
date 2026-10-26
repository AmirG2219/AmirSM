/**
 * Deterministic detection of things the owner asked for that the engine cannot do.
 * Used by both planners so limitations are reported even when the model forgets (or there is no model).
 */
import type { AssetBrief } from './types.js';

interface Rule {
  id: string;
  /** matches the owner's request text */
  request: RegExp;
  /** if an existing limitation already covers this, don't repeat it */
  covered: RegExp;
  message: string;
  /** optional extra condition */
  when?: (ctx: { assets: AssetBrief[] }) => boolean;
}

const RULES: Rule[] = [
  {
    id: 'ai-footage',
    request: /\b(ai|a\.i\.)[- ]?(generated|made|created)?\s*(b[- ]?roll|footage|video|clips?|scenes?|images?)\b|\bgenerate\s+(some\s+|new\s+|extra\s+)?(b[- ]?roll|footage|clips?|scenes?|video)\b|\bstock\s+(footage|video|clips?)\b|\bb[- ]?roll\s+(that|which)\s+(you|the ai)\s+(make|create|generate)/i,
    covered: /b[- ]?roll|generat|stock footage|new footage/i,
    message: 'AI-generated or stock B-roll is not possible: the edit can only use the clips you uploaded. Upload the footage you want included.',
  },
  {
    id: 'music',
    request: /\b(background\s+music|add\s+(some\s+)?music|music\s+(from|off)\s+the\s+(internet|web)|trending\s+(songs?|sounds?|audio|tracks?|music)|(some|any|good|nice|upbeat|chill)\s+music|royalty[- ]free\s+music|copyright[- ]free\s+music|\bspotify\b|\bsong\b|\bsoundtrack\b|\bbeat\s+drop\b)/i,
    covered: /music|song|soundtrack/i,
    message: 'Music cannot be supplied by the app (no music library or internet audio). Upload your own audio file (you must have the rights) and it can be mixed in.',
    when: ({ assets }) => !assets.some((a) => a.kind === 'audio'),
  },
  {
    id: 'auto-captions',
    request: /\b(auto[- ]?(generate[d]?\s+)?(captions?|subtitles?|transcri\w+)|transcri(be|ption)|speech[- ]to[- ]text|(captions?|subtitles?)\s+(from|of|for)\s+(the\s+|my\s+)?(speech|audio|voice|talking|what\s+i\s+say)|subtitle\s+what\s+(i|they|we)\s+say)/i,
    covered: /transcri|auto(matic)?\s*(caption|subtitle)|speech[- ]to[- ]text/i,
    message: 'Automatic captions/transcription are not available. Subtitles can only use text you type in yourself.',
  },
  {
    id: 'speech-detection',
    request: /\b(remove|cut|trim|delete)\s+(out\s+)?(the\s+|all\s+)?(silences?|silent\s+parts|pauses|filler\s+words|ums?|uhs?)\b|\bdetect\s+(the\s+)?(speech|speaking|talking|voice|speaker|faces?|people|scenes?|best\s+moments?|highlights?)|\bjump[- ]?cuts?\s+(on|to)\s+(speech|talking|words)|\bfind\s+(the\s+)?(best|funniest|highlight)\b|\bonly\s+(the\s+)?parts?\s+where\s+i('m|\s+am)?\s+(talking|speaking)/i,
    covered: /speech|silence|detect|understand(s|ing)?\s+(the\s+)?(video|footage|content)|cannot see/i,
    message: 'The editor cannot hear or see the footage, so it cannot detect speech, silences, faces or "best moments". Pick the parts yourself or describe them with exact times.',
  },
  {
    id: 'unsupported-effects',
    request: /\b(ken\s*burns|zoom[- ]?(in|out|punch)|punch[- ]?in|glitch|camera\s+shake|shake\s+effect|particles?|stickers?|emojis?|animated\s+(text|titles?|captions?)|text\s+animations?|kinetic\s+(text|typography)|green[- ]?screen|chroma[- ]?key|background\s+(removal|blur\s+people)|face\s+track\w*|beat[- ]?sync\w*|sync\s+(the\s+)?(cuts?|clips?|edit)\s+to\s+(the\s+)?(beat|music)|voice[- ]?over|text[- ]to[- ]speech|tts\b|lip[- ]?sync|speed\s+ramp\w*|lut\b|film\s+grain|light\s+leaks?|logo\s+(overlay|animation)|watermark)/i,
    covered: /effect|animat|zoom|sticker|glitch|beat|voice|not (supported|available|possible)/i,
    message: 'Some requested effects do not exist in this engine (e.g. zoom/Ken Burns, glitch, stickers/emoji, animated text, beat sync, voiceover, green screen, speed ramps). Available: cuts, crossfade, dip-to-black, slide, speed 0.5-2x, look presets, vignette, fades, titles and your own subtitles.',
  },
];

/** Returns limitation messages for the unsupported things found in `requestText`, skipping ones already covered. */
export function detectLimitations(requestText: string, assets: AssetBrief[], existing: string[] = []): string[] {
  const out: string[] = [];
  for (const rule of RULES) {
    if (!rule.request.test(requestText)) continue;
    if (rule.when && !rule.when({ assets })) continue;
    if (existing.some((l) => rule.covered.test(l))) continue;
    out.push(rule.message);
  }
  return out;
}
