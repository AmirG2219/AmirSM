/**
 * HTML mail -> plain text, safely.
 *
 * The output is ONLY text: this app never serves or renders mail HTML, never loads remote content (images, CSS, fonts,
 * tracking pixels are not fetched — <img> becomes "[image: alt]"), and never follows links (an href is printed as text so
 * the owner can see where it really points). The scanner is a hand-written linear-time tokenizer (no regex backtracking
 * on hostile input) and the input is size-capped.
 */
import { cleanText } from './sanitize.js';

const MAX_INPUT = 1_000_000;
/** elements whose whole content is dropped */
const DROP = new Set(['script', 'style', 'head', 'title', 'template', 'noscript', 'iframe', 'object', 'embed', 'svg', 'math', 'applet', 'canvas', 'audio', 'video', 'select', 'textarea']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'form', 'fieldset', 'address', 'figure', 'figcaption', 'dl', 'dt', 'dd']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', plusmn: '±', times: '×', divide: '÷', laquo: '«', raquo: '»', larr: '←', rarr: '→', zwnj: '', zwj: '', shy: '',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß', ntilde: 'ñ', oacute: 'ó', iacute: 'í', uacute: 'ú',
};

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,8});/gi, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1]!.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    const v = NAMED[body.toLowerCase()];
    return v === undefined ? m : v;
  });
}

interface Tag { name: string; closing: boolean; selfClosing: boolean; attrs: Map<string, string>; end: number }

/** Parse the tag starting at html[i] === '<'. Returns null when it is not a tag (a literal '<'). */
function readTag(html: string, i: number): Tag | null {
  let p = i + 1;
  const closing = html[p] === '/';
  if (closing) p++;
  const nameStart = p;
  while (p < html.length && /[A-Za-z0-9:-]/.test(html[p]!)) p++;
  if (p === nameStart || !/[A-Za-z]/.test(html[nameStart]!)) return null;
  const name = html.slice(nameStart, p).toLowerCase();
  const attrs = new Map<string, string>();
  // attributes: honour quotes so a '>' inside a value does not end the tag
  while (p < html.length) {
    while (p < html.length && /\s|\//.test(html[p]!)) p++;
    if (html[p] === '>') {
      return { name, closing, selfClosing: html[p - 1] === '/', attrs, end: p + 1 };
    }
    const aStart = p;
    while (p < html.length && !/[\s=>/]/.test(html[p]!)) p++;
    const an = html.slice(aStart, p).toLowerCase();
    while (p < html.length && /\s/.test(html[p]!)) p++;
    let val = '';
    if (html[p] === '=') {
      p++;
      while (p < html.length && /\s/.test(html[p]!)) p++;
      const q = html[p];
      if (q === '"' || q === "'") {
        const e = html.indexOf(q, p + 1);
        if (e < 0) return { name, closing, selfClosing: false, attrs, end: html.length };
        val = html.slice(p + 1, e);
        p = e + 1;
      } else {
        const vs = p;
        while (p < html.length && !/[\s>]/.test(html[p]!)) p++;
        val = html.slice(vs, p);
      }
    }
    if (an && attrs.size < 20 && !attrs.has(an)) attrs.set(an, val);
    if (p === aStart) p++; // always make progress
  }
  return { name, closing, selfClosing: false, attrs, end: html.length };
}

/** Find the end of `<name ...>...</name>` content for a dropped element; case-insensitive without regex. */
function skipElement(html: string, lower: string, name: string, from: number): number {
  const close = `</${name}`;
  let p = lower.indexOf(close, from);
  while (p >= 0) {
    const after = lower[p + close.length];
    if (after === undefined || after === '>' || /\s/.test(after)) {
      const gt = lower.indexOf('>', p);
      return gt < 0 ? html.length : gt + 1;
    }
    p = lower.indexOf(close, p + 1);
  }
  return html.length; // unterminated: drop the rest (safer than showing script/style source)
}

function safeUrl(href: string): string | null {
  const h = decodeEntities(href).trim().replace(/[\u0000-\u001F\u007F\s]+/g, '');
  if (!/^(https?:\/\/|mailto:)/i.test(h)) return null; // javascript:, data:, file:, cid: ... are never shown as links
  return h.length > 300 ? h.slice(0, 300) + '…' : h;
}

export function htmlToText(input: string): string {
  const html = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  let listDepth = 0;
  const linkStack: { href: string | null; start: number }[] = [];
  let outLen = 0;
  const push = (s: string) => {
    out.push(s);
    outLen += s.length;
  };
  const nl = (n = 1) => push('\n'.repeat(n));
  let guard = 0;

  while (i < html.length && outLen < 4 * MAX_INPUT && guard++ < 2_000_000) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      push(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) push(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const e = html.indexOf('-->', lt + 4);
      i = e < 0 ? html.length : e + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      // doctype, CDATA, processing instruction
      const e = html.indexOf('>', lt + 2);
      i = e < 0 ? html.length : e + 1;
      continue;
    }
    const tag = readTag(html, lt);
    if (!tag) {
      push('<');
      i = lt + 1;
      continue;
    }
    i = tag.end;
    const { name } = tag;
    if (DROP.has(name)) {
      if (!tag.closing && !tag.selfClosing) i = skipElement(html, lower, name, i);
      continue;
    }
    if (name === 'br') {
      nl();
    } else if (name === 'hr') {
      nl();
      push('----');
      nl();
    } else if (name === 'img') {
      if (!tag.closing) {
        const alt = decodeEntities(tag.attrs.get('alt') ?? '').trim();
        push(alt ? `[image: ${alt.slice(0, 120)}]` : '[image]'); // the image itself is never fetched
      }
    } else if (name === 'a') {
      if (!tag.closing) {
        linkStack.push({ href: safeUrl(tag.attrs.get('href') ?? ''), start: out.length });
      } else {
        const l = linkStack.pop();
        if (l?.href) {
          const shown = out.slice(l.start).join('').trim();
          const bare = l.href.replace(/^mailto:/i, '');
          if (shown !== l.href && shown !== bare) push(` (${l.href})`);
        }
      }
    } else if (name === 'li') {
      if (!tag.closing) {
        nl();
        push('  '.repeat(Math.max(0, listDepth - 1)) + '- ');
      }
    } else if (name === 'ul' || name === 'ol') {
      listDepth = Math.max(0, listDepth + (tag.closing ? -1 : 1));
      nl();
    } else if (name === 'td' || name === 'th') {
      if (tag.closing) push('\t');
    } else if (BLOCK.has(name)) {
      nl(/^h[1-6]$/.test(name) || name === 'p' ? 2 : 1);
    }
  }
  return tidy(out.join(''));
}

/** Normalise whitespace of a plain-text rendering. */
export function tidy(text: string): string {
  return cleanText(text)
    .replace(/[ \t ]+\n/g, '\n')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t+$/gm, '')
    .trim();
}
