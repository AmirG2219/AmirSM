import { useEffect, useMemo, useState } from 'react';
import type { AssetDTO, VersionDTO } from '@shared/api';
import type { Caption } from '@shared/domain';
import { api, ApiError } from '../../api/client';
import { Badge, Button, Callout, ProgressBar, Textarea } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import type { AiAvailability } from '../../hooks/ai';
import { copyText } from '../../lib/url';
import { dedupeNotes, formatBytes, formatDateTime, formatDuration} from '../../lib/format';

/* =====================================================================================
   Optional "what the editor saw" data. The field may not exist yet; everything is optional-chained.
   ===================================================================================== */
interface AnalysisClip {
  assetId?: string;
  name?: string;
  summary?: string;
  tags?: string[];
  moments?: unknown[];
}
interface Analysis {
  visual?: boolean;
  technical?: boolean;
  framesAnalyzed?: number;
  clips?: AnalysisClip[];
  notes?: string[];
}
const analysisOf = (v: VersionDTO): Analysis | null => (v as VersionDTO & { analysis?: Analysis | null }).analysis ?? null;

const momentText = (m: unknown): string => {
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') {
    const o = m as Record<string, unknown>;
    const t = [o.description, o.text, o.label, o.summary].find((x) => typeof x === 'string') as string | undefined;
    const at = typeof o.atMs === 'number' ? `${(o.atMs / 1000).toFixed(1)}s` : typeof o.startMs === 'number' ? `${(o.startMs / 1000).toFixed(1)}s` : '';
    return [at, t].filter(Boolean).join(' · ');
  }
  return '';
};

/* =====================================================================================
   Badges
   ===================================================================================== */
export function PlanSourceBadge({ source }: { source: 'ai' | 'rules' }) {
  return source === 'ai' ? (
    <Badge tone="accent" title="The edit plan was written by the AI model and then validated by the video engine.">
      AI edit
    </Badge>
  ) : (
    <Badge tone="warn" title="The edit plan was built by fixed rules, without AI. It cannot interpret your wording beyond basic cues.">
      Basic auto-edit — no AI
    </Badge>
  );
}

/* =====================================================================================
   Progress
   ===================================================================================== */
const STAGE_TEXT: Record<string, string> = {
  analyzing: 'Analyzing your clips',
  planning: 'Planning the edit',
  validating: 'Checking the plan',
  rendering: 'Rendering the video',
  captioning: 'Writing the caption',
  reviewing: 'Running final checks',
};
const GROUPS: { label: string; stages: string[] }[] = [
  { label: 'Analyze', stages: ['analyzing'] },
  { label: 'Plan', stages: ['planning', 'validating'] },
  { label: 'Render', stages: ['rendering'] },
  { label: 'Caption', stages: ['captioning'] },
  { label: 'Check', stages: ['reviewing'] },
];

export function ProgressView({ version, onChanged }: { version: VersionDTO; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const job = version.job;
  const stage: string | null = (job?.stage as string | null) ?? (version.status === 'planning' || version.status === 'rendering' || version.status === 'captioning' ? version.status : null);
  const queued = version.status === 'queued' && !stage;
  const showAnalyze = stage === 'analyzing' || !!analysisOf(version);
  const groups = GROUPS.filter((g) => g.label !== 'Analyze' || showAnalyze);
  const idx = stage ? groups.findIndex((g) => g.stages.includes(stage)) : -1;
  const title = queued ? 'Waiting in the queue' : stage ? STAGE_TEXT[stage] ?? job?.message ?? 'Working on your video' : 'Working on your video';
  const pct = job ? Math.round(job.progress * 100) : null;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.versions.cancel(version.id);
      toast.push({ tone: 'info', title: 'Cancelling', message: 'It will stop shortly.' });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not cancel');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className="progress-view" aria-labelledby="pv-h">
      <div className="pv-top">
        <span className="spinner pv-spin" aria-hidden="true" />
        <div style={{ minWidth: 0 }}>
          <h2 id="pv-h">{title}…</h2>
          <p className="small muted" role="status" aria-live="polite">
            {job?.message ?? (queued ? 'This will start automatically.' : 'This usually takes a minute or two.')}
          </p>
        </div>
        <span className="spacer" />
        {pct != null && !queued ? <span className="pv-pct">{pct}%</span> : null}
      </div>
      <ProgressBar value={queued ? null : job?.progress ?? null} label={`Version ${version.number} progress`} indeterminate={queued || !job} />
      <ol className="stages" style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }} aria-label="Stages">
        {groups.map((g, i) => (
          <li key={g.label} className={i < idx ? 'stage-done' : i === idx ? 'stage-now' : ''} aria-current={i === idx ? 'step' : undefined}>
            <span className="stage-dot" aria-hidden="true">{i < idx ? <Icon name="check" size="sm" /> : null}</span>
            {g.label}
          </li>
        ))}
      </ol>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="tiny faint">
          {job && job.attempt > 1 ? `Attempt ${job.attempt} of ${job.maxAttempts}. An earlier attempt failed and is being retried. ` : ''}
          It keeps running if you leave this page.
        </span>
        <Button size="sm" variant="quiet" onClick={() => void cancel()} busy={cancelling}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

/* =====================================================================================
   Failed / cancelled
   ===================================================================================== */
export function FailedView({ version, onChanged, anyOtherActive }: { version: VersionDTO; onChanged: () => Promise<void> | void; anyOtherActive: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<null | 'retry' | 'replan'>(null);
  const cancelled = version.status === 'cancelled';
  const run = async (replan: boolean) => {
    setBusy(replan ? 'replan' : 'retry');
    try {
      await api.versions.retry(version.id, replan);
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not retry');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="failed-view" aria-labelledby="fail-h">
      <Callout tone={cancelled ? 'info' : 'err'} title={<span id="fail-h">{cancelled ? 'This version was cancelled' : 'This version could not be finished'}</span>}>
        <p style={{ margin: 0, overflowWrap: 'anywhere' }}>{version.error ?? version.job?.error ?? (cancelled ? 'You cancelled it before it finished.' : 'It stopped without reporting an error.')}</p>
      </Callout>
      <div className="row" style={{ marginTop: 'var(--s-4)' }}>
        <Button variant="primary" icon="refresh" busy={busy === 'retry'} disabled={busy !== null || anyOtherActive} onClick={() => void run(false)}>
          Retry
        </Button>
        <Button icon="refresh" busy={busy === 'replan'} disabled={busy !== null || anyOtherActive} onClick={() => void run(true)}>
          Retry with a fresh plan
        </Button>
      </div>
      <p className="tiny muted" style={{ marginTop: 8 }}>
        Retry runs it again as planned. A fresh plan throws the saved plan away and plans again.
        {anyOtherActive ? ' Another version is being made; wait for it to finish first.' : ''}
      </p>
    </section>
  );
}

/* =====================================================================================
   Ready / approved
   ===================================================================================== */
export function ReadyView({
  version,
  assets,
  posterUrl,
  ai,
  anyActive,
  onChanged,
  onCreated,
  hideRevise,
}: {
  hideRevise?: boolean;
  version: VersionDTO;
  assets: AssetDTO[];
  posterUrl: string | null;
  ai: AiAvailability;
  anyActive: boolean;
  onChanged: () => Promise<void> | void;
  onCreated: (v: VersionDTO) => Promise<void> | void;
}) {
  const out = version.output!;
  const limitations = dedupeNotes(version.plan?.limitations ?? []);
  const analysis = analysisOf(version);
  const ratio = out.width && out.height ? `${out.width} / ${out.height}` : '9 / 16';

  return (
    <div className="stack-l">
      <div className="rv">
        <div className="rv-video">
          <div className="player" style={{ aspectRatio: ratio }}>
            <video key={version.id + (version.finishedAt ?? '')} controls playsInline preload="metadata" poster={posterUrl ?? undefined} src={out.url} aria-label={`Video, version ${version.number}`}>
              Your browser can’t play this video. Use the download button instead.
            </video>
          </div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            {formatDuration(out.durationMs)} · {out.width}×{out.height} · {formatBytes(out.sizeBytes)}
          </div>
        </div>

        <div className="rv-side stack-l">
          <ApproveBlock version={version} onChanged={onChanged} />
          <CaptionBlock version={version} ai={ai} onChanged={onChanged} />
          {version.plan && !hideRevise ? <ReviseBlock version={version} ai={ai} anyActive={anyActive} onCreated={onCreated} /> : null}
        </div>
      </div>

      {limitations.length ? (
        <Callout tone="warn" title="What I couldn’t do">
          <ul>
            {limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {analysis?.visual === true ? <SawSection analysis={analysis} /> : null}
      <EditedSection version={version} assets={assets} />
    </div>
  );
}

/* ---------- Approve & download ---------- */
function ApproveBlock({ version, onChanged }: { version: VersionDTO; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const out = version.output!;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    try {
      await api.versions.approve(version.id);
      setConfirm(false);
      toast.success(`Version ${version.number} approved`, 'Your download is ready below.');
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not approve');
      if (e instanceof ApiError && e.status === 409) {
        setConfirm(false);
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  if (version.status === 'approved') {
    return (
      <div className="approved-block">
        <div className="row-nowrap" style={{ gap: 10 }}>
          <span className="approved-mark"><Icon name="check" /></span>
          <div>
            <h2 style={{ fontSize: 18 }}>Approved</h2>
            <p className="small muted">{formatDateTime(version.approvedAt)}. A permanent copy was saved and will not be overwritten.</p>
          </div>
        </div>
        <div className="row" style={{ marginTop: 'var(--s-4)' }}>
          <a className="btn btn-primary btn-lg" href={out.downloadUrl} download>
            <Icon name="download" /> Download video
          </a>
          {version.caption ? (
            <a className="btn btn-lg" href={api.versions.captionUrl(version.id, true)} download>
              <Icon name="download" /> Download caption
            </a>
          ) : null}
        </div>
        {version.exportPath ? <p className="tiny faint" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>Saved in your data folder at <span className="mono">{version.exportPath}</span></p> : null}
      </div>
    );
  }

  if (version.status === 'superseded') {
    return (
      <Callout tone="info">
        Another version was approved, so this one is kept for reference. You can still watch and download it.
        <div style={{ marginTop: 10 }}>
          <a className="btn btn-sm" href={out.downloadUrl} download>
            <Icon name="download" size="sm" /> Download video
          </a>
        </div>
      </Callout>
    );
  }

  return (
    <div>
      <Button variant="primary" size="lg" icon="check" block onClick={() => setConfirm(true)}>
        Approve &amp; download
      </Button>
      <p className="tiny muted" style={{ marginTop: 8 }}>Happy with it? Approving saves a permanent copy and unlocks the download. Want something different? Request changes below.</p>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        locked={busy}
        title={`Approve version ${version.number}?`}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirm(false)} disabled={busy}>Not yet</Button>
            <Button variant="primary" icon="check" busy={busy} onClick={() => void approve()}>Approve</Button>
          </>
        }
      >
        <div className="stack">
          <p>This saves a permanent, read-only copy of the video, the caption and the edit plan. Exports are never overwritten. Other versions awaiting review are marked superseded.</p>
          {!version.caption ? <Callout tone="warn">This version has no caption. The export will contain the video and the edit plan only.</Callout> : null}
        </div>
      </Modal>
    </div>
  );
}

/* ---------- Caption ---------- */
const TAG_RE = /^[\p{L}\p{N}_]{1,40}$/u;
const parseTags = (s: string) => s.split(/[\s,]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);

function CaptionBlock({ version, ai, onChanged }: { version: VersionDTO; ai: AiAvailability; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const editable = version.status === 'ready';
  const [editing, setEditing] = useState(false);
  const [regen, setRegen] = useState(false);
  const cap = version.caption;
  const aiBlocked = ai.configured === false;

  const copy = async () => {
    if (!version.captionText) return;
    if (await copyText(version.captionText)) toast.success('Caption copied');
    else toast.push({ tone: 'warn', title: 'Could not copy', message: 'Select the text and copy it manually.' });
  };

  const who =
    version.captionStatus === 'ai' ? 'Written by AI' : version.captionStatus === 'manual' ? 'Written by you' : null;

  return (
    <section aria-labelledby="cap-h" className="cap-block">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 id="cap-h" className="block-title">Caption</h2>
        {who ? <span className="tiny muted">{who}</span> : null}
      </div>

      {editing ? (
        <CaptionEditor
          version={version}
          initial={cap}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            toast.success('Caption saved');
            await onChanged();
          }}
        />
      ) : cap ? (
        <div className="caption">
          <p className="caption-hook">{cap.hook}</p>
          <p className="caption-body">{cap.body}</p>
          {cap.cta ? <p className="caption-cta">{cap.cta}</p> : null}
          {cap.hashtags.length ? (
            <div className="chip-list" aria-label="Hashtags">
              {cap.hashtags.map((h) => (
                <span key={h} className="chip">#{h}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="stack-s">
          {version.captionNote && (version.captionStatus === 'unavailable' || version.captionStatus === 'failed') ? (
            <p className="small muted">{version.captionNote}</p>
          ) : aiBlocked ? (
            <p className="small muted">No caption was generated: {ai.reason ?? 'AI is not connected.'} You can write one yourself.</p>
          ) : (
            <p className="small muted">No caption yet.</p>
          )}
        </div>
      )}

      {!editing ? (
        <div className="row" style={{ marginTop: 'var(--s-3)' }}>
          {cap ? <Button size="sm" icon="copy" onClick={() => void copy()}>Copy</Button> : null}
          {editable ? (
            <>
              <Button size="sm" icon="edit" onClick={() => setEditing(true)}>{cap ? 'Edit' : 'Write a caption'}</Button>
              <Button size="sm" variant="quiet" icon="refresh" disabled={aiBlocked} onClick={() => setRegen(true)} title={aiBlocked ? ai.reason ?? 'AI is not available.' : undefined}>
                {cap ? 'Regenerate' : 'Generate with AI'}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {editable && !editing && aiBlocked && cap ? <p className="tiny muted" style={{ marginTop: 6 }}>AI captions are off: {ai.reason ?? 'no Anthropic API key is configured.'}</p> : null}
      <RegenerateDialog open={regen} onClose={() => setRegen(false)} versionId={version.id} onDone={onChanged} />
    </section>
  );
}

function CaptionEditor({ version, initial, onCancel, onSaved }: { version: VersionDTO; initial: Caption | null; onCancel: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [hook, setHook] = useState(initial?.hook ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [cta, setCta] = useState(initial?.cta ?? '');
  const [tags, setTags] = useState((initial?.hashtags ?? []).map((t) => `#${t}`).join(' '));
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState({ hook: false, body: false });

  const tagList = parseTags(tags);
  const badTag = tagList.find((t) => !TAG_RE.test(t));
  const errors = {
    hook: !hook.trim() ? 'The hook is required.' : hook.length > 200 ? 'At most 200 characters.' : undefined,
    body: !body.trim() ? 'The body is required.' : body.length > 1800 ? 'At most 1800 characters.' : undefined,
    cta: cta.length > 240 ? 'At most 240 characters.' : undefined,
    tags: tagList.length > 15 ? 'At most 15 hashtags.' : badTag ? `“${badTag}” isn’t valid: letters, numbers or underscores only.` : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);
  const shown = (k: 'hook' | 'body') => (touched[k] || (k === 'hook' ? hook : body).length > 0 ? errors[k] : undefined);

  const save = async () => {
    setBusy(true);
    try {
      await api.versions.patchCaption(version.id, { hook: hook.trim(), body: body.trim(), cta: cta.trim(), hashtags: tagList });
      await onSaved();
    } catch (e) {
      toast.error(e, 'Could not save the caption');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!invalid) void save(); }}>
      <Textarea label="Hook" rows={2} value={hook} onChange={(e) => setHook(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, hook: true }))} error={shown('hook')} hint={`${hook.length}/200`} />
      <Textarea label="Body" rows={5} value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, body: true }))} error={shown('body')} hint={`${body.length}/1800`} />
      <Textarea label="Call to action" optional rows={2} value={cta} onChange={(e) => setCta(e.target.value)} error={errors.cta} />
      <div className="field">
        <label htmlFor="cap-tags">Hashtags <span className="faint" style={{ fontWeight: 400 }}>· optional</span></label>
        <input id="cap-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#slowliving #morning" aria-invalid={errors.tags ? true : undefined} />
        {errors.tags ? <div className="error-text" role="alert">{errors.tags}</div> : <div className="hint">Separate with spaces. The # is optional.</div>}
      </div>
      <div className="row">
        <Button type="submit" variant="primary" busy={busy} disabled={invalid}>Save caption</Button>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </form>
  );
}

function RegenerateDialog({ open, onClose, versionId, onDone }: { open: boolean; onClose: () => void; versionId: string; onDone: () => Promise<void> | void }) {
  const toast = useToast();
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await api.versions.regenerateCaption(versionId, feedback.trim() || undefined);
      toast.success('New caption written');
      setFeedback('');
      onClose();
      await onDone();
    } catch (e) {
      toast.error(e, 'Could not regenerate the caption');
      if (e instanceof ApiError && e.status === 409) onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      title="Regenerate caption"
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" icon="refresh" busy={busy} onClick={() => void run()}>Regenerate</Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">The current caption will be replaced. This counts toward your daily AI limit.</p>
        <Textarea label="Feedback for the writer" optional rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={1000} placeholder="e.g. shorter, less formal" />
      </div>
    </Modal>
  );
}

/* ---------- Request changes ---------- */
function ReviseBlock({ version, ai, anyActive, onCreated }: { version: VersionDTO; ai: AiAvailability; anyActive: boolean; onCreated: (v: VersionDTO) => Promise<void> | void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(''), [version.id]);
  const blocked = ai.configured === false;

  const submit = async () => {
    setBusy(true);
    try {
      const v = await api.versions.create(version.projectId, { instruction: text.trim(), baseVersionId: version.id });
      toast.success(`Making version ${v.number}`);
      setText('');
      await onCreated(v);
    } catch (e) {
      toast.error(e, 'Could not start the changes');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="rev-h" className="rev-block">
      <h2 id="rev-h" className="block-title">Request changes</h2>
      {blocked ? (
        <p className="small muted">Changes need the AI model, which is not connected. {ai.reason ?? ''} A basic auto-edit can’t interpret change requests.</p>
      ) : (
        <Textarea
          label="What should change?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={5000}
          placeholder="e.g. Open on the sunrise shot, make the second clip shorter, warmer look."
          hint="A new version is made. This one is kept."
        />
      )}
      {blocked ? null : (
      <div className="row" style={{ marginTop: 'var(--s-3)' }}>
        <Button icon="refresh" busy={busy} disabled={text.trim().length < 3 || anyActive || blocked} onClick={() => void submit()}>
          Apply changes
        </Button>
        {anyActive ? <span className="tiny muted">Another version is being made.</span> : null}
      </div>
      )}
    </section>
  );
}

/* ---------- What the editor saw (only when real visual analysis exists) ---------- */
function SawSection({ analysis }: { analysis: Analysis }) {
  const clips = analysis.clips ?? [];
  return (
    <details className="disclosure">
      <summary>What the editor saw</summary>
      <div className="disclosure-body stack">
        <p className="small muted">
          The editor looked at {analysis.framesAnalyzed ?? 'a number of'} sampled frames across your clips. These are its notes; it can be wrong.
        </p>
        {clips.map((c, i) => {
          const moments = (c.moments ?? []).map(momentText).filter(Boolean);
          return (
            <div key={c.assetId ?? i} className="saw-clip">
              <div style={{ fontWeight: 600 }}>{c.name ?? `Clip ${i + 1}`}</div>
              {c.summary ? <p className="small" style={{ margin: '2px 0' }}>{c.summary}</p> : null}
              {c.tags?.length ? (
                <div className="chip-list" aria-label="Tags">
                  {c.tags.map((t) => <span key={t} className="chip">{t}</span>)}
                </div>
              ) : null}
              {moments.length ? (
                <ul className="bullets small">
                  {moments.map((m, j) => <li key={j}>{m}</li>)}
                </ul>
              ) : null}
            </div>
          );
        })}
        {analysis.notes?.length ? (
          <ul className="bullets small">
            {dedupeNotes(analysis.notes).map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

/* ---------- How this was edited (technical details, collapsed) ---------- */
const TRANSITION: Record<string, string> = { cut: 'Cut', crossfade: 'Crossfade', 'dip-to-black': 'Dip to black', 'slide-left': 'Slide' };
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const CHECK_ICON: Record<string, { icon: IconName; color: string }> = {
  pass: { icon: 'circle-check', color: 'var(--ok)' },
  warn: { icon: 'alert', color: 'var(--warn)' },
  fail: { icon: 'circle-x', color: 'var(--err)' },
};

function EditedSection({ version, assets }: { version: VersionDTO; assets: AssetDTO[] }) {
  const plan = version.plan;
  const names = useMemo(() => new Map(assets.map((a) => [a.id, a.originalName])), [assets]);
  const notes = dedupeNotes(version.planNotes);
  const q = version.quality;
  if (!plan && !notes.length && !q) return null;
  return (
    <details className="disclosure">
      <summary>
        How this was edited
        {version.planSource ? <PlanSourceBadge source={version.planSource} /> : null}
        {q && q.overall !== 'pass' ? <Badge tone={q.overall === 'warn' ? 'warn' : 'err'}>{q.overall === 'warn' ? 'Some warnings' : 'Problems found'}</Badge> : null}
      </summary>
      <div className="disclosure-body stack">
        {version.planRationale ? <p style={{ margin: 0 }}>{version.planRationale}</p> : null}
        {plan?.summary ? <p className="small muted" style={{ margin: 0 }}>{plan.summary}</p> : null}
        {notes.length ? (
          <div>
            <div className="eyebrow">Notes</div>
            <ul className="bullets small">
              {notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>
        ) : null}
        {plan ? (
          <>
            <div>
              <div className="eyebrow">{plan.segments.length} {plan.segments.length === 1 ? 'segment' : 'segments'}</div>
              <ol className="segments">
                {plan.segments.map((s, i) => (
                  <li key={s.id}>
                    <span className="seg-n">{i + 1}</span>
                    <div className="seg-main">
                      <div className="truncate" style={{ fontWeight: 600 }} title={names.get(s.assetId) ?? s.assetId}>{names.get(s.assetId) ?? 'Unknown clip'}</div>
                      <div className="seg-meta">
                        <span>{sec(s.startMs)} – {sec(s.endMs)}</span>
                        {s.speed !== 1 ? <span>{s.speed}× speed</span> : null}
                        <span>{s.fit === 'cover' ? 'Fills frame' : 'Whole frame over blur'}</span>
                        {s.audio === 'mute' ? <span>Muted</span> : null}
                        {i > 0 ? <span>In: {TRANSITION[s.transitionIn.type] ?? s.transitionIn.type}{s.transitionIn.type !== 'cut' ? ` ${s.transitionIn.durationMs} ms` : ''}</span> : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            {plan.titles.length ? (
              <div>
                <div className="eyebrow">On-screen titles</div>
                <ul className="plain-list">
                  {plan.titles.map((t) => (
                    <li key={t.id}><span>“{t.text}”</span><span className="tiny faint nowrap">{sec(t.startMs)}–{sec(t.endMs)}</span></li>
                  ))}
                </ul>
              </div>
            ) : null}
            <dl className="kv">
              <dt>Format</dt><dd>{plan.format} · {plan.fps} fps</dd>
              <dt>Look</dt><dd>{plan.look.preset}{plan.look.vignette ? ' · vignette' : ''}</dd>
              <dt>Audio</dt><dd>{plan.audio.normalizeLoudness ? 'Loudness evened out' : 'Loudness unchanged'}</dd>
            </dl>
          </>
        ) : null}
        {version.warnings.length ? (
          <div>
            <div className="eyebrow">Warnings</div>
            <ul className="bullets small">
              {version.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        ) : null}
        {q ? (
          <div>
            <div className="eyebrow">Quality checks</div>
            <ul className="checks">
              {q.checks.map((c) => {
                const m = CHECK_ICON[c.status]!;
                return (
                  <li key={c.id}>
                    <span style={{ color: m.color, display: 'inline-flex', marginTop: 2 }}><Icon name={m.icon} /></span>
                    <div>
                      <div style={{ fontWeight: 600 }}>{c.label} <span className="sr-only">{c.status}</span></div>
                      <div className="small muted">{c.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="tiny faint">Checked by {q.sources.includes('ai') ? 'file measurements and an AI consistency pass' : 'file and video measurements; no AI review was run'}.</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}
