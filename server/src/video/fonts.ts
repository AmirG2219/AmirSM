/**
 * Font discovery + a tiny TrueType/OpenType reader (name, cmap, hmtx) so we can
 *  - pick a font that actually contains the glyphs of a title (e.g. Amharic/Ethiopic needs Ebrima/Nyala, not Segoe UI),
 *  - measure text to wrap titles inside the frame,
 *  - give libass the exact family name for the ASS style.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export class FontFace {
  constructor(
    public readonly file: string,
    public readonly family: string,
    public readonly bold: boolean,
    private readonly upem: number,
    private readonly cmapLookup: (cp: number) => number,
    private readonly advances: Uint16Array,
  ) {}

  covers(cp: number): boolean {
    return this.cmapLookup(cp) !== 0;
  }

  /** advance width in em units (1 = font size) */
  advanceEm(cp: number): number {
    const gid = this.cmapLookup(cp);
    if (gid === 0 && !isInvisible(cp)) return 0.6;
    const n = this.advances.length;
    if (n === 0) return 0.55;
    const adv = this.advances[Math.min(gid, n - 1)] ?? 0;
    return adv / this.upem;
  }

  measureEm(text: string): number {
    let w = 0;
    for (const ch of text) w += this.advanceEm(ch.codePointAt(0)!);
    return w;
  }
}

/** characters we never require a glyph for */
export function isInvisible(cp: number): boolean {
  return cp <= 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff || cp === 0xa0 || cp === 0x2028 || cp === 0x2029;
}

function u16(b: Buffer, o: number): number {
  return b.readUInt16BE(o);
}
function u32(b: Buffer, o: number): number {
  return b.readUInt32BE(o);
}

export function parseFont(buf: Buffer, file: string): FontFace {
  let base = 0;
  if (buf.toString('latin1', 0, 4) === 'ttcf') base = u32(buf, 12);
  const numTables = u16(buf, base + 4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const e = base + 12 + i * 16;
    tables.set(buf.toString('latin1', e, e + 4), { off: u32(buf, e + 8), len: u32(buf, e + 12) });
  }
  const head = tables.get('head');
  const cmap = tables.get('cmap');
  if (!head || !cmap) throw new Error('not a usable font (missing head/cmap)');
  const upem = u16(buf, head.off + 18) || 1000;

  // --- names
  let family = path.basename(file, path.extname(file));
  let bold = /bold|bd\b/i.test(path.basename(file));
  const nameT = tables.get('name');
  if (nameT) {
    const count = u16(buf, nameT.off + 2);
    const strOff = nameT.off + u16(buf, nameT.off + 4);
    const pick = new Map<number, string>();
    const prio = new Map<number, number>();
    for (let i = 0; i < count; i++) {
      const r = nameT.off + 6 + i * 12;
      const platform = u16(buf, r);
      const lang = u16(buf, r + 4);
      const nameId = u16(buf, r + 6);
      const len = u16(buf, r + 8);
      const off = strOff + u16(buf, r + 10);
      if (nameId !== 1 && nameId !== 2) continue;
      let s: string;
      let p: number;
      if (platform === 3 || platform === 0) {
        const raw = Buffer.from(buf.subarray(off, off + len));
        raw.swap16();
        s = raw.toString('utf16le');
        p = platform === 3 && lang === 0x409 ? 3 : 2;
      } else if (platform === 1) {
        s = buf.toString('latin1', off, off + len);
        p = 1;
      } else continue;
      if ((prio.get(nameId) ?? 0) < p) {
        pick.set(nameId, s);
        prio.set(nameId, p);
      }
    }
    if (pick.get(1)) family = pick.get(1)!;
    const sub = pick.get(2);
    if (sub !== undefined) bold = /bold/i.test(sub);
  }

  // --- hmtx
  let advances = new Uint16Array(0);
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  if (hhea && hmtx) {
    const n = Math.min(u16(buf, hhea.off + 34), Math.floor(hmtx.len / 4));
    advances = new Uint16Array(n);
    for (let i = 0; i < n; i++) advances[i] = u16(buf, hmtx.off + i * 4);
  }

  // --- cmap
  const nTab = u16(buf, cmap.off + 2);
  let best: { off: number; score: number } | null = null;
  for (let i = 0; i < nTab; i++) {
    const r = cmap.off + 4 + i * 8;
    const platform = u16(buf, r);
    const enc = u16(buf, r + 2);
    const off = cmap.off + u32(buf, r + 4);
    const fmt = u16(buf, off);
    if (fmt !== 4 && fmt !== 12) continue;
    let score = 0;
    if (platform === 3 && enc === 10) score = 5;
    else if (platform === 0 && fmt === 12) score = 4;
    else if (platform === 3 && enc === 1) score = 3;
    else if (platform === 0) score = 2;
    else continue;
    if (!best || score > best.score) best = { off, score };
  }
  if (!best) throw new Error('font has no Unicode cmap');
  const sub = best.off;
  const fmt = u16(buf, sub);
  let lookup: (cp: number) => number;
  if (fmt === 12) {
    const nGroups = u32(buf, sub + 12);
    lookup = (cp) => {
      let lo = 0;
      let hi = nGroups - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = sub + 16 + mid * 12;
        const s = u32(buf, g);
        const e = u32(buf, g + 4);
        if (cp < s) hi = mid - 1;
        else if (cp > e) lo = mid + 1;
        else return u32(buf, g + 8) + (cp - s);
      }
      return 0;
    };
  } else {
    const segX2 = u16(buf, sub + 6);
    const segCount = segX2 / 2;
    const endO = sub + 14;
    const startO = endO + segX2 + 2;
    const deltaO = startO + segX2;
    const rangeO = deltaO + segX2;
    lookup = (cp) => {
      if (cp > 0xffff) return 0;
      for (let i = 0; i < segCount; i++) {
        if (cp > u16(buf, endO + i * 2)) continue;
        const start = u16(buf, startO + i * 2);
        if (cp < start) return 0;
        const delta = u16(buf, deltaO + i * 2);
        const ro = u16(buf, rangeO + i * 2);
        if (ro === 0) return (cp + delta) & 0xffff;
        const addr = rangeO + i * 2 + ro + (cp - start) * 2;
        if (addr + 2 > buf.length) return 0;
        const gid = u16(buf, addr);
        return gid === 0 ? 0 : (gid + delta) & 0xffff;
      }
      return 0;
    };
  }
  return new FontFace(file, family, bold, upem, lookup, advances);
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Preferred font files per platform: Latin first (bold looks best on video), then script fallbacks. */
export function systemFontCandidates(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const dir = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
    return [
      'segoeuib.ttf', 'arialbd.ttf', 'segoeui.ttf', 'arial.ttf', 'calibrib.ttf', 'verdanab.ttf', 'tahomabd.ttf',
      // script fallbacks (Ethiopic/Amharic, Indic, CJK, Korean, symbols)
      'ebrimabd.ttf', 'ebrima.ttf', 'nyala.ttf', 'nirmalab.ttf', 'msyhbd.ttc', 'msyh.ttc', 'malgunbd.ttf', 'seguisym.ttf',
    ].map((f) => path.join(dir, f));
  }
  if (platform === 'darwin') {
    return [
      '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/System/Library/Fonts/Supplemental/Kefa.ttc',
    ];
  }
  return [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf', '/usr/share/fonts/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf', '/usr/share/fonts/noto/NotoSans-Bold.ttf', '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansEthiopic-Bold.ttf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  ];
}

export interface FontPick {
  face: FontFace;
  /** characters of the text that this face has no glyph for (they will render as blanks/boxes) */
  missing: string[];
}

/** Lazily loads the explicit font (option/env) first, then system candidates. */
export class FontLibrary {
  private faces: Promise<FontFace[]> | null = null;
  constructor(private readonly explicit?: string | null, private readonly platform: NodeJS.Platform = process.platform) {}

  private load(): Promise<FontFace[]> {
    this.faces ??= (async () => {
      const files = [...(this.explicit ? [this.explicit] : []), ...systemFontCandidates(this.platform)];
      const out: FontFace[] = [];
      const seen = new Set<string>();
      for (const f of files) {
        const key = path.resolve(f).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!(await exists(f))) continue;
        try {
          out.push(parseFont(await fs.readFile(f), f));
        } catch {
          // unusable file: skip silently, another candidate will be used
        }
      }
      return out;
    })();
    return this.faces;
  }

  async available(): Promise<boolean> {
    return (await this.load()).length > 0;
  }

  async primary(): Promise<FontFace | null> {
    return (await this.load())[0] ?? null;
  }

  /** The first face that covers every visible character; otherwise the face missing the fewest. null = no fonts at all. */
  async pickFor(text: string): Promise<FontPick | null> {
    const faces = await this.load();
    if (faces.length === 0) return null;
    const cps = [...new Set([...text].map((c) => c.codePointAt(0)!).filter((cp) => !isInvisible(cp)))];
    let best: FontPick | null = null;
    for (const face of faces) {
      const missing = cps.filter((cp) => !face.covers(cp)).map((cp) => String.fromCodePoint(cp));
      if (missing.length === 0) return { face, missing };
      if (!best || missing.length < best.missing.length) best = { face, missing };
    }
    return best;
  }
}
