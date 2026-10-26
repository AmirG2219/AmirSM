/** Small, dependency-free sanitisers for text that comes from mail headers/bodies or goes into headers/filenames. */

// C0/C1 controls except \t \n; zero-width + bidi override/isolate characters used for spoofing.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Plain text from the outside world: drop control and spoofing characters, normalise line endings. */
export function cleanText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

/** A single-line value (subject, display name): no line breaks at all. */
export function cleanLine(s: string, max = 500): string {
  return cleanText(s).replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** Anything that will be written into an outgoing header: CR/LF/NUL can never survive (header injection). */
export function headerSafe(s: string): string {
  return s.replace(/[\r\n\u0000\u2028\u2029]+/g, ' ').trim();
}

const RISKY_EXT = new Set([
  'exe', 'com', 'scr', 'bat', 'cmd', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg', 'dll', 'cpl', 'pif', 'appx', 'msix', 'iso', 'img', 'sh', 'app', 'dmg', 'apk', 'docm', 'xlsm', 'pptm', 'html', 'htm', 'svg', 'xhtml', 'chm',
]);

/** A safe file name for Content-Disposition and for a download folder: no paths, no reserved characters, bounded. */
export function safeFilename(name: string | null | undefined, fallback = 'attachment'): string {
  let s = cleanText(name ?? '').replace(/[\n\t]/g, ' ');
  s = s.split(/[\\/]/).pop() ?? ''; // no directory components
  s = s.replace(/[<>:"|?*;=\u0000]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, ''); // no hidden/relative names, no trailing dots (Windows)
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(s)) s = '_' + s; // Windows reserved device names
  if (s.length > 120) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || fallback;
}

export function isRiskyFilename(name: string): boolean {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
  return !!ext && RISKY_EXT.has(ext);
}

/** Content-Disposition value with an ASCII fallback and an RFC 5987 UTF-8 name. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\%]/g, '_');
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Only content types that are inert when saved are passed through; everything else is served as an opaque download. */
const SAFE_MIME = /^(image\/(png|jpe?g|gif|webp|bmp)|application\/pdf|text\/(plain|csv)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/zip|application\/vnd\.openxmlformats-officedocument\.[a-z0-9.+-]+|application\/vnd\.ms-(excel|powerpoint)|application\/msword)$/i;
export function downloadMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  return SAFE_MIME.test(m) ? m : 'application/octet-stream';
}

/** Never let a secret reach a message that is shown to the owner or stored. */
export function redact(message: string, secrets: readonly (string | undefined | null)[]): string {
  let out = message;
  for (const s of secrets) if (s && s.length >= 3) out = out.split(s).join('***');
  return out;
}
