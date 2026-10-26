/**
 * EditPlan -> ffmpeg input list + filter_complex script + side files (title text, ASS subtitles, fonts).
 *
 * Text and font paths never appear inside the filter graph as absolute paths: ffmpeg runs with its cwd set to a
 * private scratch dir and the graph only references short relative names (t0.txt, f0.ttf, subs.ass, fonts/).
 * That sidesteps every escaping problem with spaces / apostrophes / drive letters in the repo path.
 */
import path from 'node:path';
import type { EditPlan, Segment, Title } from '../../../shared/editPlan.js';
import type { PlanAsset } from './types.js';
import { buildTimeline } from './timeline.js';
import { FontLibrary, type FontFace } from './fonts.js';

export interface GraphInput {
  /** asset id (paths are redacted to ids in the audit summary) */
  assetId: string;
  path: string;
  seekSec?: number;
  durSec?: number;
  loop?: boolean;
}

export interface SideFile {
  name: string;
  text?: string;
  /** copy this absolute file into the scratch dir under `name` */
  copyFrom?: string;
}

export interface BuiltGraph {
  inputs: GraphInput[];
  graph: string;
  files: SideFile[];
  warnings: string[];
  totalSeconds: number;
  /** false = every audio source is silent (no keep-audio clip with sound and no music) */
  hasAudioContent: boolean;
  /** contents of the fontsdir for libass, if subtitles are burned in */
  usesFontconfigDir: boolean;
}

export interface GraphCaps {
  amixNormalize: boolean;
}

const AUDIO_FMT = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

const sec = (n: number) => {
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '' || s === '-0' ? '0' : s;
};

/** chain of atempo filters for any factor (each atempo handles 0.5..2) */
export function atempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 1e-6) return [];
  const out: string[] = [];
  let s = speed;
  while (s > 2) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

const XFADE: Record<string, string> = { crossfade: 'fade', 'dip-to-black': 'fadeblack', 'slide-left': 'slideleft' };

/**
 * Look presets. Everything here runs natively in YUV (eq / lutyuv / hue): colorbalance/curves force an RGB round trip
 * that made a 1080x1920 render ~3x slower. Tints are chroma offsets (U up = bluer, V up = redder).
 */
export function lookFilters(preset: string): string[] {
  const off = (n: number) => `val${n >= 0 ? '+' : ''}${n}`;
  const tint = (du: number, dv: number) => `lutyuv=u='clip(${off(du)},16,240)':v='clip(${off(dv)},16,240)'`;
  switch (preset) {
    case 'warm':
      return [tint(-6, 7), 'eq=saturation=1.1:contrast=1.03:brightness=0.01'];
    case 'cool':
      return [tint(7, -6), 'eq=saturation=1.03'];
    case 'cinematic':
      return ['eq=contrast=1.14:saturation=0.88:gamma=0.96', tint(3, -2)];
    case 'bright':
      return ['eq=brightness=0.05:contrast=1.05:saturation=1.12'];
    case 'muted':
      return ['eq=saturation=0.7:contrast=0.96'];
    case 'bw':
      return ['hue=s=0', 'eq=contrast=1.1'];
    default:
      return [];
  }
}

/** Greedy word wrap using real glyph advances. Falls back to splitting inside very long words. */
export function wrapText(text: string, face: FontFace, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  const measure = (s: string) => face.measureEm(s) * fontSize;
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      continue;
    }
    let line = '';
    const pushWord = (w: string) => {
      if (measure(w) <= maxWidth) {
        line = w;
        return;
      }
      // hard-split an overlong word by characters
      let chunk = '';
      for (const ch of w) {
        if (measure(chunk + ch) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    };
    for (const w of words) {
      if (!line) pushWord(w);
      else if (measure(`${line} ${w}`) <= maxWidth) line = `${line} ${w}`;
      else {
        lines.push(line);
        line = '';
        pushWord(w);
      }
    }
    if (line) lines.push(line);
  }
  return lines.length > 0 ? lines : [''];
}

function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function assEscape(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n+/g, '\\N');
}

export interface SubtitleBuild {
  ass: string;
  fontFile: string;
  missing: string[];
}

export function buildAss(plan: EditPlan, width: number, height: number, totalMs: number, face: FontFace): string {
  const subs = plan.subtitles!;
  const fontSize = Math.round(width * 0.056);
  const outline = Math.max(2, Math.round(fontSize * 0.07));
  const align = subs.position === 'center' ? 5 : 2;
  const marginV = subs.position === 'center' ? 0 : Math.round(height * 0.12);
  const marginLR = Math.round(width * 0.08);
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${face.family.replace(/,/g, ' ')},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H78000000,${face.bold ? -1 : 0},0,0,0,100,100,0,0,1,${outline},${Math.max(1, Math.round(outline / 2))},${align},${marginLR},${marginLR},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const c of subs.cues) {
    if (c.startMs >= totalMs) continue;
    const end = Math.min(c.endMs, totalMs);
    if (end <= c.startMs) continue;
    lines.push(`Dialogue: 0,${assTime(c.startMs)},${assTime(end)},Default,,0,0,0,,${assEscape(c.text)}`);
  }
  return lines.join('\n') + '\n';
}

const TITLE_SIZE: Record<Title['size'], number> = { small: 0.042, medium: 0.058, large: 0.08 };

function titleY(pos: Title['position']): string {
  switch (pos) {
    case 'top':
      return 'h*0.10';
    case 'lower-third':
      return 'h*0.64';
    case 'bottom':
      return 'h*0.80-text_h';
    default:
      return '(h-text_h)/2';
  }
}

export async function buildGraph(plan: EditPlan, assets: Map<string, PlanAsset>, fonts: FontLibrary, caps: GraphCaps): Promise<BuiltGraph> {
  const tl = buildTimeline(plan);
  const { fps, width: W, height: H } = tl;
  const warnings: string[] = [];
  const inputs: GraphInput[] = [];
  const files: SideFile[] = [];
  const chains: string[] = [];
  let hasAudioContent = false;

  // ---------- per-segment video + audio
  tl.segs.forEach((ts) => {
    const i = ts.index;
    const seg: Segment = ts.segment;
    const asset = assets.get(seg.assetId)!;
    const outSec = ts.frames / fps;
    inputs.push({ assetId: seg.assetId, path: asset.path, seekSec: seg.startMs / 1000, durSec: (seg.endMs - seg.startMs) / 1000 });

    const pre = `setpts=(PTS-STARTPTS)/${seg.speed.toFixed(6)},fps=${fps}`;
    const post = `setsar=1,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=${ts.frames},setpts=PTS-STARTPTS,format=yuv420p`;
    if (seg.fit === 'contain-blur') {
      const bw = Math.round(W / 4 / 2) * 2;
      const bh = Math.round(H / 4 / 2) * 2;
      chains.push(`[${i}:v:0]${pre},split=2[bgs${i}][fgs${i}]`);
      chains.push(`[bgs${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=9,eq=brightness=-0.06,scale=${W}:${H}:flags=bilinear,setsar=1[bg${i}]`);
      chains.push(`[fgs${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1[fg${i}]`);
      chains.push(`[bg${i}][fg${i}]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=repeat,${post}[v${i}]`);
    } else {
      const fx = seg.focus.x.toFixed(4);
      const fy = seg.focus.y.toFixed(4);
      chains.push(`[${i}:v:0]${pre},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:x=(iw-${W})*${fx}:y=(ih-${H})*${fy},${post}[v${i}]`);
    }

    const hasSound = asset.info.hasAudio && seg.audio === 'keep' && seg.volume > 0;
    if (seg.audio === 'keep' && !asset.info.hasAudio) warnings.push(`Clip ${i + 1} has no audio track; silence was inserted`);
    if (hasSound) {
      hasAudioContent = true;
      const parts = [`[${i}:a:0]aresample=48000`, AUDIO_FMT, 'asetpts=PTS-STARTPTS', ...atempoChain(seg.speed)];
      if (Math.abs(seg.volume - 1) > 1e-6) parts.push(`volume=${seg.volume.toFixed(4)}`);
      parts.push('apad', `atrim=end=${sec(outSec)}`, 'asetpts=PTS-STARTPTS', AUDIO_FMT);
      chains.push(parts.join(',') + `[a${i}]`);
    } else {
      chains.push(`anullsrc=r=48000:cl=stereo:d=${sec(outSec)},${AUDIO_FMT}[a${i}]`);
    }
  });

  // ---------- joins
  let curV = 'v0';
  let curA = 'a0';
  let curFrames = tl.segs[0]!.frames;
  for (let i = 1; i < tl.segs.length; i++) {
    const ts = tl.segs[i]!;
    const jv = `jv${i}`;
    const ja = `ja${i}`;
    if (ts.transFrames === 0) {
      chains.push(`[${curV}][v${i}]concat=n=2:v=1:a=0[${jv}]`);
      chains.push(`[${curA}][a${i}]concat=n=2:v=0:a=1[${ja}]`);
      curFrames += ts.frames;
    } else {
      const type = ts.segment.transitionIn.type;
      const d = ts.transFrames / fps;
      const offset = (curFrames - ts.transFrames) / fps;
      chains.push(`[${curV}][v${i}]xfade=transition=${XFADE[type] ?? 'fade'}:duration=${sec(d)}:offset=${sec(offset)}[${jv}]`);
      chains.push(`[${curA}][a${i}]acrossfade=d=${sec(d)}:c1=tri:c2=tri[${ja}]`);
      curFrames += ts.frames - ts.transFrames;
    }
    curV = jv;
    curA = ja;
  }
  const totalSeconds = curFrames / fps;
  const totalMs = totalSeconds * 1000;

  // ---------- video post: look, vignette, titles, subtitles, fades
  const vpost: string[] = [...lookFilters(plan.look.preset)];
  if (plan.look.vignette) vpost.push('vignette=angle=PI/5');

  const fontNames = new Map<string, string>();
  const copyFont = (face: FontFace, prefix: string): string => {
    let name = fontNames.get(face.file);
    if (!name) {
      name = `${prefix}${fontNames.size}${path.extname(face.file).toLowerCase() || '.ttf'}`;
      fontNames.set(face.file, name);
      files.push({ name, copyFrom: face.file });
    }
    return name;
  };

  const titles = plan.titles ?? [];
  for (let k = 0; k < titles.length; k++) {
    const t = titles[k]!;
    if (t.startMs >= totalMs) continue;
    const pick = await fonts.pickFor(t.text);
    if (!pick) {
      warnings.push(`Title "${t.text.slice(0, 30)}" was not drawn: no usable font file was found on this machine`);
      continue;
    }
    if (pick.missing.length > 0) warnings.push(`Title "${t.text.slice(0, 30)}": the font cannot draw these characters: ${pick.missing.slice(0, 8).join(' ')}`);
    const fs = Math.round(W * TITLE_SIZE[t.size]);
    const pad = Math.round(fs * 0.32);
    const lines = wrapText(t.text, pick.face, fs, W * 0.86 - 2 * pad);
    const fontName = copyFont(pick.face, 'f');
    const textName = `t${k}.txt`;
    files.push({ name: textName, text: lines.join('\n') });
    const s = t.startMs / 1000;
    const e = Math.min(t.endMs, totalMs) / 1000;
    const fade = Math.min(0.25, (e - s) / 3);
    const alpha = `min(1,min((t-${sec(s)})/${sec(fade)},(${sec(e)}-t)/${sec(fade)}))`;
    vpost.push(
      [
        `drawtext=fontfile=${fontName}`,
        `textfile=${textName}`,
        'expansion=none',
        `fontsize=${fs}`,
        'fontcolor=white',
        'text_align=center',
        `line_spacing=${Math.round(fs * 0.12)}`,
        'x=(w-text_w)/2',
        `y=${titleY(t.position)}`,
        'box=1',
        `boxcolor=black@0.5`,
        `boxborderw=${pad}`,
        'shadowcolor=black@0.6',
        'shadowx=2',
        'shadowy=2',
        `alpha='${alpha}'`,
        `enable='between(t,${sec(s)},${sec(e)})'`,
      ].join(':'),
    );
  }

  let usesFontsDir = false;
  const cues = plan.subtitles?.cues ?? [];
  if (plan.subtitles && cues.length > 0) {
    const pick = await fonts.pickFor(cues.map((c) => c.text).join('\n'));
    if (!pick) {
      warnings.push('Subtitles were not drawn: no usable font file was found on this machine');
    } else {
      if (pick.missing.length > 0) warnings.push(`Subtitles: the font cannot draw these characters: ${pick.missing.slice(0, 8).join(' ')}`);
      files.push({ name: 'subs.ass', text: buildAss(plan, W, H, totalMs, pick.face) });
      files.push({ name: `fonts/${path.basename(pick.face.file)}`, copyFrom: pick.face.file });
      vpost.push('ass=filename=subs.ass:fontsdir=fonts');
      usesFontsDir = true;
    }
  }

  const fi = plan.look.fadeInMs / 1000;
  const fo = plan.look.fadeOutMs / 1000;
  if (fi > 0) vpost.push(`fade=t=in:st=0:d=${sec(Math.min(fi, totalSeconds))}`);
  if (fo > 0) vpost.push(`fade=t=out:st=${sec(Math.max(0, totalSeconds - fo))}:d=${sec(Math.min(fo, totalSeconds))}`);
  vpost.push('format=yuv420p');
  chains.push(`[${curV}]${vpost.join(',')}[vout]`);

  // ---------- audio post: music, loudness, fades
  const apost: string[] = [];
  let mixIn = curA;
  const music = plan.audio.music;
  if (music) {
    const m = assets.get(music.assetId)!;
    hasAudioContent = true;
    const idx = inputs.length;
    inputs.push({ assetId: music.assetId, path: m.path, loop: true, durSec: totalSeconds + 1 });
    const mfo = Math.min(music.fadeOutMs / 1000, totalSeconds);
    const mp = [`[${idx}:a:0]aresample=48000`, AUDIO_FMT, 'asetpts=PTS-STARTPTS', `atrim=end=${sec(totalSeconds)}`, 'asetpts=PTS-STARTPTS', `volume=${music.volume.toFixed(4)}`];
    if (mfo > 0) mp.push(`afade=t=out:st=${sec(Math.max(0, totalSeconds - mfo))}:d=${sec(mfo)}`);
    chains.push(mp.join(',') + '[mus]');
    // amix halves each input unless normalize=0; compensate on old builds that lack the option
    chains.push(caps.amixNormalize ? `[${curA}][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]` : `[${curA}][mus]amix=inputs=2:duration=first:dropout_transition=0,volume=2[mix]`);
    mixIn = 'mix';
  }
  if (plan.audio.normalizeLoudness && hasAudioContent) apost.push('loudnorm=I=-14:TP=-1.5:LRA=11', 'aresample=48000', AUDIO_FMT);
  if (fi > 0) apost.push(`afade=t=in:st=0:d=${sec(Math.min(fi, totalSeconds))}`);
  if (fo > 0) apost.push(`afade=t=out:st=${sec(Math.max(0, totalSeconds - fo))}:d=${sec(Math.min(fo, totalSeconds))}`);
  apost.push('anull');
  chains.push(`[${mixIn}]${apost.join(',')}[aout]`);

  return { inputs, graph: chains.join(';\n') + '\n', files, warnings, totalSeconds, hasAudioContent, usesFontconfigDir: usesFontsDir };
}
