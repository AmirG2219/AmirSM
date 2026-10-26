import { useEffect, useMemo, useState } from 'react';
import type { AssetDTO, VersionDTO } from '@shared/api';
import type { Caption } from '@shared/domain';
import { api, ApiError } from '../../api/client';
import { Badge, Button, Callout, EmptyState, ProgressBar, StatusPill, Textarea } from '../../components/ui';
import { Icon, type IconName } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { VERSION_STATUS, dedupeNotes, versionStatusInfo, formatBytes, formatDateTime, formatDuration, isActiveStatus, relativeTime } from '../../lib/format';

export interface AiAvailability {
  /** null = unknown (status could not be loaded); the server stays the source of truth. */
  configured: boolean | null;
  reason: string | null;
}

/* =====================================================================================
   Version history rail
   ===================================================================================== */
export function VersionRail({
  versions,
  selectedId,
  onSelect,
  onCompare,
}: {
  versions: VersionDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCompare: () => void;
}) {
  const comparable = versions.filter((v) => v.output).length >= 2;
  return (
    <aside className="vrail card" aria-label="Version history">
      <div className="card-head">
        <h2>Versions</h2>
        <span className="spacer" />
        {comparable ? (
          <Button size="sm" variant="quiet" onClick={onCompare}>
            Compare
          </Button>
        ) : null}
      </div>
      <ol className="vrail-list">
        {versions.map((v) => {
          const st = versionStatusInfo(v);
          const selected = v.id === selectedId;
          return (
            <li key={v.id}>
              <button type="button" className={`vitem${selected ? ' vitem-on' : ''}`} onClick={() => onSelect(v.id)} aria-current={selected ? 'true' : undefined}>
                <div className="row-nowrap" style={{ gap: 8 }}>
                  <span className="vnum">v{v.number}</span>
                  <StatusPill label={st.label} tone={st.tone} active={isActiveStatus(v.status)} />
                  {v.approved ? (
                    <span className="vapproved" title="This is the approved version">
                      <Icon name="circle-check" size="sm" />
                    </span>
                  ) : null}
                </div>
                <div className="vinstr">{v.instruction || (v.isRevision ? '(no instruction)' : 'First draft from your brief')}</div>
                <div className="tiny faint">
                  {v.isRevision ? 'Revision · ' : 'First draft · '}
                  {relativeTime(v.createdAt)}
                  {v.planSource ? ` · ${v.planSource === 'ai' ? 'AI edit' : 'Basic edit'}` : ''}
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/* =====================================================================================
   Review panel for one version
   ===================================================================================== */
export function ReviewPanel({
  version,
  versions,
  assets,
  posterUrl,
  ai,
  anyActive,
  onChanged,
  onCreated,
}: {
  version: VersionDTO;
  versions: VersionDTO[];
  assets: AssetDTO[];
  posterUrl: string | null;
  ai: AiAvailability;
  anyActive: boolean;
  onChanged: () => Promise<void> | void;
  onCreated: (v: VersionDTO) => Promise<void> | void;
}) {
  const st = versionStatusInfo(version);
  const parent = version.parentVersionId ? versions.find((v) => v.id === version.parentVersionId) : null;
  const hasOutput = !!version.output && ['ready', 'approved', 'superseded'].includes(version.status);

  return (
    <div className="stack-l">
      <section className="card" aria-labelledby="rv-head">
        <div className="card-body stack">
          <div className="row">
            <h2 id="rv-head" className="section-title">
              Version {version.number}
            </h2>
            <StatusPill label={st.label} tone={st.tone} active={isActiveStatus(version.status)} />
            {version.planSource ? <PlanSourceBadge source={version.planSource} /> : null}
            {version.approved ? (
              <Badge tone="ok">
                <Icon name="check" size="sm" /> Approved version
              </Badge>
            ) : null}
          </div>
          <div className="tiny muted">
            {version.isRevision ? `Revision${parent ? ` of v${parent.number}` : ''} · ` : 'First draft · '}
            created {formatDateTime(version.createdAt)}
            {version.finishedAt ? ` · finished ${formatDateTime(version.finishedAt)}` : ''}
          </div>
          {version.instruction ? (
            <figure className="request">
              <figcaption className="eyebrow">{version.isRevision ? 'What you asked to change' : 'Brief used for this draft'}</figcaption>
              <blockquote>{version.instruction}</blockquote>
            </figure>
          ) : null}
        </div>
      </section>

      {isActiveStatus(version.status) ? <ProgressCard version={version} onChanged={onChanged} /> : null}
      {version.status === 'failed' || version.status === 'cancelled' ? <FailedCard version={version} onChanged={onChanged} anyOtherActive={anyActive} /> : null}

      {hasOutput ? (
        <div className="review">
          <div className="review-media stack">
            <MediaCard version={version} posterUrl={posterUrl} onChanged={onChanged} />
          </div>
          <div className="review-side stack">
            <CaptionCard version={version} ai={ai} onChanged={onChanged} />
          </div>
        </div>
      ) : null}

      {version.plan && version.status !== 'failed' && version.status !== 'cancelled' && !isActiveStatus(version.status) ? (
        <ReviseCard version={version} ai={ai} anyActive={anyActive} onCreated={onCreated} />
      ) : null}
      {version.plan || version.planRationale || version.planNotes.length ? <PlanCard version={version} assets={assets} /> : null}
      {version.quality || version.warnings.length ? <QualityCard version={version} /> : null}
    </div>
  );
}

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

/* ---------- Progress ---------- */
const STAGES = ['Plan the edit', 'Render the video', 'Write the caption', 'Quality check'];
function stageIndex(v: VersionDTO): number {
  const s = v.job?.stage;
  if (s === 'planning' || s === 'validating') return 0;
  if (s === 'rendering') return 1;
  if (s === 'captioning') return 2;
  if (s === 'reviewing') return 3;
  if (v.status === 'planning') return 0;
  if (v.status === 'rendering') return 1;
  if (v.status === 'captioning') return 2;
  return -1;
}

function ProgressCard({ version, onChanged }: { version: VersionDTO; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const job = version.job;
  const idx = stageIndex(version);
  const queued = version.status === 'queued' && idx < 0;
  const pct = job ? Math.round(job.progress * 100) : null;

  const cancel = async () => {
    setCancelling(true);
    try {
      await api.versions.cancel(version.id);
      toast.push({ tone: 'info', title: 'Cancelling', message: 'The draft will stop shortly.' });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not cancel');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className="card" aria-labelledby="prog-h">
      <div className="card-head">
        <span className="spinner" aria-hidden="true" style={{ color: 'var(--accent)' }} />
        <h2 id="prog-h">{queued ? 'Waiting in the queue' : 'Producing this draft'}</h2>
        <span className="spacer" />
        <Button size="sm" variant="danger" icon="stop" onClick={() => void cancel()} busy={cancelling}>
          Cancel
        </Button>
      </div>
      <div className="card-body stack">
        <ProgressBar value={queued ? null : job?.progress ?? null} label={`Version ${version.number} progress`} indeterminate={queued || !job} />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <p className="small" role="status" aria-live="polite" style={{ margin: 0 }}>
            {job?.message ?? (queued ? 'Another job may be running first. This will start automatically.' : 'Working…')}
          </p>
          {pct != null && !queued ? <span className="small muted nowrap">{pct}%</span> : null}
        </div>
        <ol className="stages" aria-label="Stages">
          {STAGES.map((label, i) => (
            <li key={label} className={i < idx ? 'stage-done' : i === idx ? 'stage-now' : ''} aria-current={i === idx ? 'step' : undefined}>
              <span className="stage-dot" aria-hidden="true">
                {i < idx ? <Icon name="check" size="sm" /> : null}
              </span>
              {label}
            </li>
          ))}
        </ol>
        {job && job.attempt > 1 ? (
          <p className="tiny muted">
            Attempt {job.attempt} of {job.maxAttempts}. An earlier attempt failed and is being retried automatically.
          </p>
        ) : null}
        <p className="tiny faint">This runs on your machine and keeps going if you leave this page.</p>
      </div>
    </section>
  );
}

/* ---------- Failure ---------- */
function FailedCard({ version, onChanged, anyOtherActive }: { version: VersionDTO; onChanged: () => Promise<void> | void; anyOtherActive: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<null | 'retry' | 'replan'>(null);
  const cancelled = version.status === 'cancelled';
  const run = async (replan: boolean) => {
    setBusy(replan ? 'replan' : 'retry');
    try {
      await api.versions.retry(version.id, replan);
      toast.push({ tone: 'info', title: replan ? 'Planning again' : 'Retrying', message: `Draft v${version.number} is back in the queue.` });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not retry');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card" aria-labelledby="fail-h">
      <div className="card-body stack">
        <Callout tone={cancelled ? 'info' : 'err'} title={<span id="fail-h">{cancelled ? 'This draft was cancelled' : 'This draft failed'}</span>}>
          <p style={{ margin: 0, wordBreak: 'break-word' }}>{version.error ?? version.job?.error ?? (cancelled ? 'You cancelled it before it finished.' : 'It stopped without reporting an error.')}</p>
          {version.job ? (
            <p className="tiny muted" style={{ marginTop: 6 }}>
              Attempt {version.job.attempt} of {version.job.maxAttempts}.
            </p>
          ) : null}
        </Callout>
        <div className="row">
          <Button variant="primary" icon="refresh" busy={busy === 'retry'} disabled={busy !== null || anyOtherActive} onClick={() => void run(false)}>
            Retry
          </Button>
          <Button icon="refresh" busy={busy === 'replan'} disabled={busy !== null || anyOtherActive} onClick={() => void run(true)}>
            Retry with fresh plan
          </Button>
        </div>
        <p className="tiny muted">
          <strong>Retry</strong> re-runs with the same edit plan (good for temporary problems). <strong>Retry with fresh plan</strong> discards the saved plan and plans again (good if the plan itself was the problem).
          {anyOtherActive ? ' Another draft is being produced; wait for it to finish first.' : ''}
        </p>
      </div>
    </section>
  );
}

/* ---------- Video + approve + downloads ---------- */
function MediaCard({ version, posterUrl, onChanged }: { version: VersionDTO; posterUrl: string | null; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const out = version.output!;
  const [confirm, setConfirm] = useState(false);
  const [approving, setApproving] = useState(false);

  const approve = async () => {
    setApproving(true);
    try {
      await api.versions.approve(version.id);
      setConfirm(false);
      toast.success(`Version ${version.number} approved`, 'An exported copy was saved and will not be overwritten.');
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not approve');
      if (e instanceof ApiError && e.status === 409) {
        setConfirm(false);
        await onChanged();
      }
    } finally {
      setApproving(false);
    }
  };

  const ratio = out.width && out.height ? `${out.width} / ${out.height}` : '9 / 16';

  return (
    <section className="card card-flush" aria-label={`Video for version ${version.number}`}>
      <div className="player" style={{ aspectRatio: ratio }}>
        <video key={version.id + (version.finishedAt ?? '')} controls playsInline preload="metadata" poster={posterUrl ?? undefined} src={out.url}>
          Your browser can’t play this video. Use the download button instead.
        </video>
      </div>
      <div className="card-body stack">
        <div className="tiny muted">
          {formatDuration(out.durationMs)} · {out.width}×{out.height} · {formatBytes(out.sizeBytes)}
        </div>
        {version.status === 'approved' ? (
          <Callout tone="ok" title="Approved and exported">
            <p style={{ margin: 0 }}>
              Approved {formatDateTime(version.approvedAt)}. A permanent copy of the video{version.caption ? ', caption' : ''} and edit plan was saved
              {version.exportPath ? (
                <>
                  {' '}
                  in your data folder at <span className="mono" style={{ wordBreak: 'break-all' }}>{version.exportPath}</span>
                </>
              ) : null}
              . It is never overwritten.
            </p>
          </Callout>
        ) : null}
        {version.status === 'superseded' ? (
          <Callout tone="info">Another version was approved, so this draft is kept for reference only. You can still watch and download it.</Callout>
        ) : null}
        <div className="row">
          {version.status === 'ready' ? (
            <Button variant="primary" icon="check" onClick={() => setConfirm(true)}>
              Approve
            </Button>
          ) : null}
          <a className="btn" href={out.downloadUrl} download>
            <Icon name="download" /> Download video
          </a>
          {version.caption ? (
            <a className="btn" href={api.versions.captionUrl(version.id, true)} download>
              <Icon name="download" /> Download caption
            </a>
          ) : null}
        </div>
        {version.status === 'ready' ? <p className="tiny muted">Approving saves an exported copy. Until then this is a draft you can revise.</p> : null}
      </div>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        locked={approving}
        title={`Approve version ${version.number}?`}
        footer={
          <>
            <Button variant="quiet" onClick={() => setConfirm(false)} disabled={approving}>
              Not yet
            </Button>
            <Button variant="primary" icon="check" busy={approving} onClick={() => void approve()}>
              Approve and export
            </Button>
          </>
        }
      >
        <div className="stack">
          <p>
            This saves a permanent, read-only copy of the video, the caption and the edit plan. Exports are never overwritten, and any other drafts awaiting review will be marked superseded.
          </p>
          {!version.caption ? <Callout tone="warn">This draft has no caption. The export will contain the video and the edit plan only.</Callout> : null}
          {version.planSource === 'rules' ? <Callout tone="info">This is a Basic auto-edit (no AI), so it only used simple rules.</Callout> : null}
        </div>
      </Modal>
    </section>
  );
}

/* ---------- Caption ---------- */
const TAG_RE = /^[\p{L}\p{N}_]{1,40}$/u;
const parseTags = (s: string) => s.split(/[\s,]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);

function CaptionCard({ version, ai, onChanged }: { version: VersionDTO; ai: AiAvailability; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const editable = version.status === 'ready';
  const [editing, setEditing] = useState(false);
  const [regen, setRegen] = useState(false);
  const cap = version.caption;

  const statusBadge =
    version.captionStatus === 'ai' ? (
      <Badge tone="accent">AI-written</Badge>
    ) : version.captionStatus === 'manual' ? (
      <Badge tone="info">Written by you</Badge>
    ) : version.captionStatus === 'unavailable' ? (
      <Badge tone="warn">Not generated</Badge>
    ) : version.captionStatus === 'failed' ? (
      <Badge tone="err">Failed</Badge>
    ) : (
      <Badge>No caption</Badge>
    );

  const copy = async () => {
    if (!version.captionText) return;
    try {
      await navigator.clipboard.writeText(version.captionText);
      toast.success('Caption copied');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = version.captionText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast.success('Caption copied');
      } catch {
        toast.push({ tone: 'warn', title: 'Could not copy', message: 'Select the text and copy it manually.' });
      }
    }
  };

  const aiBlocked = ai.configured === false;

  return (
    <section className="card" aria-labelledby="cap-h">
      <div className="card-head">
        <Icon name="edit" className="faint" />
        <h2 id="cap-h">Caption</h2>
        {statusBadge}
      </div>
      <div className="card-body stack">
        {version.captionNote && (version.captionStatus === 'unavailable' || version.captionStatus === 'failed') ? (
          <Callout tone={version.captionStatus === 'failed' ? 'err' : 'warn'} title={version.captionStatus === 'failed' ? 'Caption generation failed' : 'No caption was generated'}>
            {version.captionNote}
          </Callout>
        ) : null}
        {version.captionNote && version.captionStatus !== 'unavailable' && version.captionStatus !== 'failed' ? <p className="small muted">{version.captionNote}</p> : null}

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
                  <span key={h} className="chip">
                    #{h}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : version.captionNote && (version.captionStatus === 'unavailable' || version.captionStatus === 'failed') ? (
          editable ? <p className="small muted">You can write the caption yourself below.</p> : null
        ) : (
          <EmptyState compact title="No caption yet">
            {editable ? 'You can write one yourself, or generate one when AI is connected.' : 'This version has no caption.'}
          </EmptyState>
        )}

        {(editable || cap) && !editing ? (
          <div className="row">
            {cap ? (
              <Button size="sm" icon="copy" onClick={() => void copy()}>
                Copy
              </Button>
            ) : null}
            {editable ? (
              <>
                <Button size="sm" icon="edit" onClick={() => setEditing(true)}>
                  {cap ? 'Edit' : 'Write caption'}
                </Button>
                <Button size="sm" icon="refresh" disabled={aiBlocked} onClick={() => setRegen(true)} title={aiBlocked ? ai.reason ?? 'AI is not available.' : undefined}>
                  {cap ? 'Regenerate' : 'Generate with AI'}
                </Button>
              </>
            ) : null}
          </div>
        ) : null}
        {editable && !editing && aiBlocked ? (
          <p className="tiny muted">
            AI generation is off: {ai.reason ?? 'no Anthropic API key is configured.'} You can still write the caption yourself.
          </p>
        ) : null}
        {!editable && version.status !== 'ready' && cap ? <p className="tiny faint">Captions can only be edited while a draft is awaiting review.</p> : null}
      </div>

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

  const tagList = parseTags(tags);
  const badTag = tagList.find((t) => !TAG_RE.test(t));
  const errors = {
    hook: !hook.trim() ? 'The hook is required.' : hook.length > 200 ? 'At most 200 characters.' : undefined,
    body: !body.trim() ? 'The body is required.' : body.length > 1800 ? 'At most 1800 characters.' : undefined,
    cta: cta.length > 240 ? 'At most 240 characters.' : undefined,
    tags: tagList.length > 15 ? 'At most 15 hashtags.' : badTag ? `“${badTag}” isn’t valid: use letters, numbers or underscores only (max 40).` : undefined,
  };
  const invalid = Object.values(errors).some(Boolean);
  const [touched, setTouched] = useState({ hook: false, body: false });
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
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) void save();
      }}
    >
      <Textarea label="Hook" rows={2} value={hook} onChange={(e) => setHook(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, hook: true }))} error={shown('hook')} hint={`${hook.length}/200`} />
      <Textarea label="Body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => setTouched((t) => ({ ...t, body: true }))} error={shown('body')} hint={`${body.length}/1800`} />
      <Textarea label="Call to action" optional rows={2} value={cta} onChange={(e) => setCta(e.target.value)} error={errors.cta} />
      <div className="field">
        <label htmlFor="cap-tags">
          Hashtags <span className="faint" style={{ fontWeight: 400 }}>· optional</span>
        </label>
        <input id="cap-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="#slowliving #morning" aria-invalid={errors.tags ? true : undefined} />
        <div className="hint">Separate with spaces or commas. The # is optional.</div>
        {errors.tags ? (
          <div className="error-text" role="alert">
            {errors.tags}
          </div>
        ) : null}
      </div>
      <div className="row">
        <Button type="submit" variant="primary" busy={busy} disabled={invalid}>
          Save caption
        </Button>
        <Button variant="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
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
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon="refresh" busy={busy} onClick={() => void run()}>
            Regenerate
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">The current caption will be replaced. Counts toward your daily AI usage limit.</p>
        <Textarea label="Feedback for the writer" optional rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} maxLength={1000} placeholder="e.g. shorter, less formal, no exclamation marks" />
      </div>
    </Modal>
  );
}

/* ---------- Edit plan ---------- */
const TRANSITION: Record<string, string> = { cut: 'Cut', crossfade: 'Crossfade', 'dip-to-black': 'Dip to black', 'slide-left': 'Slide left' };
const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function PlanCard({ version, assets }: { version: VersionDTO; assets: AssetDTO[] }) {
  const plan = version.plan;
  const names = useMemo(() => new Map(assets.map((a) => [a.id, a.originalName])), [assets]);
  const limitations = dedupeNotes(plan?.limitations ?? []);
  const notes = dedupeNotes(version.planNotes);
  const music = plan?.audio.music;

  return (
    <section className="card" aria-labelledby="plan-h">
      <div className="card-head">
        <Icon name="list" className="faint" />
        <h2 id="plan-h">How this was edited</h2>
        {version.planSource ? <PlanSourceBadge source={version.planSource} /> : null}
      </div>
      <div className="card-body stack">
        {limitations.length ? (
          <Callout tone="warn" title="What I couldn’t do">
            <ul>
              {limitations.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {notes.length ? (
          <Callout tone="info" title="Notes on this edit">
            <ul>
              {notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {version.planRationale ? (
          <div>
            <div className="eyebrow">Why it was cut this way</div>
            <p style={{ marginTop: 4 }}>{version.planRationale}</p>
          </div>
        ) : null}

        {plan ? (
          <>
            {plan.summary ? (
              <div>
                <div className="eyebrow">Summary</div>
                <p style={{ marginTop: 4 }}>{plan.summary}</p>
              </div>
            ) : null}
            <details className="disclosure" open>
              <summary>
                {plan.segments.length} {plan.segments.length === 1 ? 'segment' : 'segments'}
              </summary>
              <ol className="segments">
                {plan.segments.map((s, i) => (
                  <li key={s.id}>
                    <span className="seg-n">{i + 1}</span>
                    <div className="seg-main">
                      <div className="truncate" style={{ fontWeight: 600 }} title={names.get(s.assetId) ?? s.assetId}>
                        {names.get(s.assetId) ?? 'Unknown clip'}
                      </div>
                      <div className="seg-meta">
                        <span>
                          {sec(s.startMs)} – {sec(s.endMs)} of the clip
                        </span>
                        {s.speed !== 1 ? <span>{s.speed}× speed</span> : null}
                        <span>{s.fit === 'cover' ? 'Fills frame' : 'Whole frame over blur'}</span>
                        {s.audio === 'mute' ? <span>Muted</span> : null}
                        {i > 0 ? (
                          <span>
                            In: {TRANSITION[s.transitionIn.type] ?? s.transitionIn.type}
                            {s.transitionIn.type !== 'cut' ? ` ${s.transitionIn.durationMs} ms` : ''}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </details>
            {plan.titles.length ? (
              <details className="disclosure">
                <summary>
                  {plan.titles.length} on-screen {plan.titles.length === 1 ? 'title' : 'titles'}
                </summary>
                <ul className="plain-list">
                  {plan.titles.map((t) => (
                    <li key={t.id}>
                      <span>“{t.text}”</span>
                      <span className="tiny faint nowrap">
                        {sec(t.startMs)}–{sec(t.endMs)} · {t.position}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {plan.subtitles?.cues.length ? (
              <details className="disclosure">
                <summary>{plan.subtitles.cues.length} subtitle lines (your own text)</summary>
                <ul className="plain-list">
                  {plan.subtitles.cues.map((c, i) => (
                    <li key={i}>
                      <span>{c.text}</span>
                      <span className="tiny faint nowrap">
                        {sec(c.startMs)}–{sec(c.endMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            <dl className="kv">
              <dt>Format</dt>
              <dd>
                {plan.format} · {plan.fps} fps
              </dd>
              <dt>Look</dt>
              <dd>
                {plan.look.preset}
                {plan.look.vignette ? ' · vignette' : ''}
                {plan.look.fadeInMs ? ` · fade in ${plan.look.fadeInMs} ms` : ''}
                {plan.look.fadeOutMs ? ` · fade out ${plan.look.fadeOutMs} ms` : ''}
              </dd>
              <dt>Audio</dt>
              <dd>
                {plan.audio.normalizeLoudness ? 'Loudness evened out' : 'Loudness unchanged'}
                {music ? ` · your music “${names.get(music.assetId) ?? 'audio track'}” at ${Math.round(music.volume * 100)}%` : ' · no music'}
              </dd>
            </dl>
          </>
        ) : null}
      </div>
    </section>
  );
}

/* ---------- Quality ---------- */
const CHECK_ICON: Record<string, { icon: IconName; color: string }> = {
  pass: { icon: 'circle-check', color: 'var(--ok)' },
  warn: { icon: 'alert', color: 'var(--warn)' },
  fail: { icon: 'circle-x', color: 'var(--err)' },
};

function QualityCard({ version }: { version: VersionDTO }) {
  const q = version.quality;
  return (
    <section className="card" aria-labelledby="q-h">
      <div className="card-head">
        <Icon name="circle-check" className="faint" />
        <h2 id="q-h">Quality report</h2>
        {q ? (
          <Badge tone={q.overall === 'pass' ? 'ok' : q.overall === 'warn' ? 'warn' : 'err'}>
            {q.overall === 'pass' ? 'All checks passed' : q.overall === 'warn' ? 'Passed with warnings' : 'Problems found'}
          </Badge>
        ) : null}
      </div>
      <div className="card-body stack">
        {version.warnings.length ? (
          <Callout tone="warn" title="Warnings">
            <ul>
              {version.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : null}
        {q ? (
          <>
            <ul className="checks">
              {q.checks.map((c) => {
                const m = CHECK_ICON[c.status]!;
                return (
                  <li key={c.id}>
                    <span style={{ color: m.color, display: 'inline-flex', marginTop: 2 }}>
                      <Icon name={m.icon} />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {c.label} <span className="sr-only">{c.status}</span>
                      </div>
                      <div className="small muted">{c.detail}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="tiny faint">
              Checked by: {q.sources.includes('deterministic') ? 'file and video measurements' : ''}
              {q.sources.length === 2 ? ' and ' : ''}
              {q.sources.includes('ai') ? 'an AI consistency pass' : q.sources.length ? '' : 'no checks recorded'}
              {q.sources.includes('ai') ? '' : '. No AI review was run.'}
            </p>
          </>
        ) : (
          <p className="small muted">No quality checks were recorded for this version.</p>
        )}
      </div>
    </section>
  );
}

/* ---------- Revise ---------- */
function ReviseCard({ version, ai, anyActive, onCreated }: { version: VersionDTO; ai: AiAvailability; anyActive: boolean; onCreated: (v: VersionDTO) => Promise<void> | void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(''), [version.id]);
  const tooShort = text.trim().length < 3;

  const submit = async () => {
    setBusy(true);
    try {
      const v = await api.versions.create(version.projectId, { instruction: text.trim(), baseVersionId: version.id });
      toast.success(`Revision v${v.number} queued`);
      setText('');
      await onCreated(v);
    } catch (e) {
      toast.error(e, 'Could not start the revision');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="rev-h">
      <div className="card-head">
        <Icon name="refresh" className="faint" />
        <h2 id="rev-h">Revise</h2>
        <span className="small muted">Starts a new version based on v{version.number}</span>
      </div>
      <div className="card-body stack">
        {ai.configured === false ? (
          <Callout tone="warn" title="Revisions are unavailable: AI is not connected">
            Applying the changes you describe needs the AI model; the Basic auto-edit cannot interpret them, so a revision would fail. {ai.reason ?? ''} You can still edit the caption and approve a draft.
          </Callout>
        ) : null}
        <Textarea
          label="What should change?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          maxLength={5000}
          placeholder="e.g. Open on the sunrise shot, cut the second clip shorter, and use a warmer look."
          hint="Be specific. Things the engine can’t do (such as new footage or auto-transcription) will be reported under “What I couldn’t do”."
        />
        <div className="row">
          <Button
            variant="primary"
            icon="play"
            busy={busy}
            disabled={tooShort || anyActive || ai.configured === false}
            onClick={() => void submit()}
            title={ai.configured === false ? 'Needs the AI model, which is not connected.' : anyActive ? 'Wait for the current draft to finish.' : undefined}
          >
            Create revision
          </Button>
          {anyActive ? <span className="small muted">A draft is being produced; wait for it to finish.</span> : null}
        </div>
      </div>
    </section>
  );
}

/* =====================================================================================
   Compare two versions side by side
   ===================================================================================== */
export function CompareDialog({ open, onClose, versions, initialId }: { open: boolean; onClose: () => void; versions: VersionDTO[]; initialId: string | null }) {
  const withVideo = versions.filter((v) => v.output);
  const [a, setA] = useState<string>('');
  const [b, setB] = useState<string>('');
  useEffect(() => {
    if (!open) return;
    const first = withVideo.find((v) => v.id === initialId) ?? withVideo[0];
    const second = withVideo.find((v) => v.id !== first?.id);
    setA(first?.id ?? '');
    setB(second?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (id: string) => withVideo.find((v) => v.id === id);
  const side = (id: string, set: (s: string) => void, label: string) => {
    const v = pick(id);
    return (
      <div className="stack-s">
        <label className="label" htmlFor={`cmp-${label}`} style={{ fontSize: 13, fontWeight: 600 }}>
          {label}
        </label>
        <select id={`cmp-${label}`} className="select" value={id} onChange={(e) => set(e.target.value)}>
          {withVideo.map((x) => (
            <option key={x.id} value={x.id}>
              v{x.number} · {VERSION_STATUS[x.status].label}
            </option>
          ))}
        </select>
        {v?.output ? (
          <div className="player" style={{ aspectRatio: `${v.output.width} / ${v.output.height}` }}>
            <video key={v.id} controls playsInline preload="metadata" src={v.output.url} />
          </div>
        ) : null}
        {v ? (
          <div className="tiny muted">
            {v.planSource === 'ai' ? 'AI edit' : v.planSource === 'rules' ? 'Basic auto-edit — no AI' : ''} · {formatDuration(v.output?.durationMs)} · “{v.instruction.slice(0, 120) || 'First draft'}”
          </div>
        ) : null}
      </div>
    );
  };
  return (
    <Modal open={open} onClose={onClose} title="Compare versions">
      <div className="compare">
        {side(a, setA, 'Left')}
        {side(b, setB, 'Right')}
      </div>
    </Modal>
  );
}
