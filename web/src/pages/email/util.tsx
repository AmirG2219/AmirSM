import type { EmailDraftDTO } from '@shared/api';
import { Badge } from '../../components/ui';

export function initials(name: string): string {
  const base = name.replace(/<.*>/, '').trim() || name;
  const parts = base.split(/[\s@._-]+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[parts.length - 1]![0] : '';
  return (a + b).toUpperCase();
}

const TONES = ['a', 'b', 'c', 'd', 'e'];
export const avatarTone = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length]!;
};

export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${avatarTone(name)} avatar-${size}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Short mail-style time: time today, "Oct 25" this year, otherwise with the year. */
export function mailTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Split a plain-text message into new text and the quoted reply history below it. */
export function splitQuoted(body: string): { main: string; quoted: string | null } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // "On <date>, <name> wrote:" (possibly wrapped onto the next line)
    if (/^on .{5,200}$/i.test(l) && /wrote:\s*$/i.test(lines[i + 1] ?? '')) { cut = i; break; }
    if (/^on .{5,300}wrote:\s*$/i.test(l)) { cut = i; break; }
    if (/^-{2,}\s*(original message|forwarded message)\s*-{2,}/i.test(l)) { cut = i; break; }
    if (/^_{5,}\s*$/.test(l) && /^from:/i.test(lines[i + 1] ?? '')) { cut = i; break; }
    if (/^from:\s.+/i.test(l) && /^(sent|date):/i.test(lines[i + 1] ?? '') && i > 0) { cut = i; break; }
    // a trailing block of "> quoted" lines
    if (l.startsWith('>')) {
      const rest = lines.slice(i).filter((x) => x.trim());
      if (rest.every((x) => x.startsWith('>'))) { cut = i; break; }
    }
  }
  if (cut <= 0) return { main: body, quoted: null };
  const main = lines.slice(0, cut).join('\n').trimEnd();
  if (!main.trim()) return { main: body, quoted: null };
  return { main, quoted: lines.slice(cut).join('\n') };
}

export function draftStatusBadge(d: Pick<EmailDraftDTO, 'status' | 'sendResult'>) {
  if (d.status === 'sent') return d.sendResult?.delivered ? <Badge tone="ok" dot>Sent</Badge> : <Badge tone="warn" dot>Recorded locally, not delivered</Badge>;
  if (d.status === 'approved') return <Badge tone="ok" dot>Approved, not sent</Badge>;
  if (d.status === 'failed') return <Badge tone="err" dot>Send failed</Badge>;
  return <Badge dot>Draft</Badge>;
}

export const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[^\s@<>()[\],;:"]{2,}$/;

/** Accepts "Name <a@b.co>" or "a@b.co"; returns the bare address or null. */
export function parseAddress(raw: string): string | null {
  const t = raw.trim();
  const m = /<([^>]+)>$/.exec(t);
  const addr = (m ? m[1]! : t).trim();
  return EMAIL_RE.test(addr) ? addr : null;
}
