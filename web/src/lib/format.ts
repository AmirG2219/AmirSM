import type { VersionDTO } from '@shared/api';
import type { ProjectStatus, VersionStatus } from '@shared/domain';
import type { OutputFormat, StylePreset } from '@shared/editPlan';

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0 && ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

export function relativeTime(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const sec = (t - nowMs) / 1000;
  const a = Math.abs(sec);
  if (a < 45) return 'just now';
  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (a < 3600) [value, unit] = [sec / 60, 'minute'];
  else if (a < 86_400) [value, unit] = [sec / 3600, 'hour'];
  else if (a < 86_400 * 7) [value, unit] = [sec / 86_400, 'day'];
  else if (a < 86_400 * 30) [value, unit] = [sec / (86_400 * 7), 'week'];
  else if (a < 86_400 * 365) [value, unit] = [sec / (86_400 * 30), 'month'];
  else [value, unit] = [sec / (86_400 * 365), 'year'];
  const r = Math.round(value);
  if (rtf) return rtf.format(r, unit);
  return `${Math.abs(r)} ${unit}${Math.abs(r) === 1 ? '' : 's'} ${r < 0 ? 'ago' : 'from now'}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'accent';

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  processing: { label: 'In production', tone: 'accent' },
  review: { label: 'Needs review', tone: 'info' },
  approved: { label: 'Approved', tone: 'ok' },
  failed: { label: 'Failed', tone: 'err' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const VERSION_STATUS: Record<VersionStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  planning: { label: 'Planning', tone: 'accent' },
  rendering: { label: 'Rendering', tone: 'accent' },
  captioning: { label: 'Writing caption', tone: 'accent' },
  ready: { label: 'Ready for review', tone: 'info' },
  approved: { label: 'Approved', tone: 'ok' },
  failed: { label: 'Failed', tone: 'err' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  superseded: { label: 'Superseded', tone: 'neutral' },
};

export function versionStatusInfo(v: Pick<VersionDTO, 'status'>): { label: string; tone: Tone } {
  return VERSION_STATUS[v.status];
}

export const ACTIVE_VERSION_STATUSES: readonly VersionStatus[] = ['queued', 'planning', 'rendering', 'captioning'];
export const isActiveStatus = (s: VersionStatus) => ACTIVE_VERSION_STATUSES.includes(s);

export const STYLE_OPTIONS: { id: StylePreset; label: string; blurb: string }[] = [
  { id: 'day-in-the-life', label: 'Day in the life', blurb: 'Brisk, chronological cuts that feel candid and lived-in.' },
  { id: 'calm-cinematic', label: 'Calm cinematic', blurb: 'Slower pacing, soft transitions and a restrained, filmic look.' },
  { id: 'motivation', label: 'Motivation', blurb: 'Punchy cuts with bold on-screen text and a driving rhythm.' },
  { id: 'storytelling', label: 'Storytelling', blurb: 'A clear beginning, middle and end, paced around your narrative.' },
  { id: 'custom', label: 'Custom', blurb: 'No preset. The edit follows your instructions as closely as it can.' },
];

export const FORMAT_OPTIONS: { id: OutputFormat; label: string; blurb: string }[] = [
  { id: '9:16', label: '9:16 vertical', blurb: 'Reels, Shorts, TikTok (1080 × 1920)' },
  { id: '4:5', label: '4:5 portrait', blurb: 'Instagram feed (1080 × 1350)' },
  { id: '1:1', label: '1:1 square', blurb: 'Square posts (1080 × 1080)' },
];

export const styleLabel = (id: string) => STYLE_OPTIONS.find((s) => s.id === id)?.label ?? id;

/** Drop notes that repeat another note (same words, or a near-identical sentence). Order is preserved. */
export function dedupeNotes(notes: string[]): string[] {
  const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
  const kept: { text: string; t: Set<string> }[] = [];
  for (const n of notes) {
    const t = tokens(n);
    const dup = kept.some((k) => {
      const inter = [...t].filter((w) => k.t.has(w)).length;
      const union = new Set([...t, ...k.t]).size || 1;
      return inter / union >= 0.7;
    });
    if (!dup) kept.push({ text: n, t });
  }
  return kept.map((k) => k.text);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
