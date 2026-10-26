/** Shared domain types and zod schemas used by server, AI layer, video layer and the web app. */
import { z } from 'zod';

export const MediaInfoSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  /** display size after applying rotation metadata */
  displayWidth: z.number().int().nonnegative(),
  displayHeight: z.number().int().nonnegative(),
  rotation: z.number().int().default(0),
  fps: z.number().nonnegative(),
  videoCodec: z.string().nullable(),
  audioCodec: z.string().nullable(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  container: z.string().nullable(),
  bitrate: z.number().int().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative(),
});
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

export const CaptionSchema = z.object({
  hook: z.string().min(1).max(200),
  body: z.string().min(1).max(1800),
  cta: z.string().max(240).default(''),
  /** without the leading '#' */
  hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u)).max(15).default([]),
});
export type Caption = z.infer<typeof CaptionSchema>;

export function captionToText(c: Caption): string {
  const tags = c.hashtags.map((h) => `#${h}`).join(' ');
  return [c.hook, '', c.body, c.cta ? `\n${c.cta}` : '', tags ? `\n${tags}` : ''].join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export const QualityCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string(),
});
export const QualityReportSchema = z.object({
  overall: z.enum(['pass', 'warn', 'fail']),
  /** 'deterministic' = ffprobe/file checks; 'ai' = LLM consistency check added on top */
  sources: z.array(z.enum(['deterministic', 'ai'])),
  checks: z.array(QualityCheckSchema),
});
export type QualityReport = z.infer<typeof QualityReportSchema>;

export const PROJECT_STATUSES = ['draft', 'processing', 'review', 'approved', 'failed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const VERSION_STATUSES = ['queued', 'planning', 'rendering', 'captioning', 'ready', 'approved', 'failed', 'superseded'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const JOB_TYPES = ['produce_version'] as const;
export type JobType = (typeof JOB_TYPES)[number];
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Which creative roles ran and how (shown truthfully in the UI). */
export const ROLES = ['creative_director', 'video_editor', 'copywriter', 'market_researcher', 'competitor_analyst', 'quality_reviewer'] as const;
export type Role = (typeof ROLES)[number];

export const ALLOWED_VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'] as const;
export const ALLOWED_AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac'] as const;
