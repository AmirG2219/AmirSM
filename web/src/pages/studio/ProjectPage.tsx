import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProjectDetail, VersionDTO } from '@shared/api';
import { ApiError, api } from '../../api/client';
import { Button, Callout, EmptyState, IconButton, LinkButton, Skeleton, StatusPill } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useAsync, useDocumentTitle, usePolling } from '../../hooks/hooks';
import { FORMAT_OPTIONS, PROJECT_STATUS, versionStatusInfo, isActiveStatus, plural, relativeTime, styleLabel } from '../../lib/format';
import { FootageStep } from './FootageStep';
import { BriefStep } from './BriefStep';
import { CompareDialog, ReviewPanel, VersionRail, type AiAvailability } from './ReviewStep';

type Step = 'footage' | 'brief' | 'review';

export function ProjectPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [compare, setCompare] = useState(false);
  const prevStatuses = useRef<Map<string, string>>(new Map());

  // AI availability drives which actions are enabled; unknown => leave enabled, the server decides.
  const aiState = useAsync((s) => api.settingsStatus(s), []);
  const ai: AiAvailability = useMemo(() => {
    const st = aiState.data;
    if (!st) return { configured: null, reason: null };
    const integ = st.integrations.find((i) => i.id === 'anthropic');
    return { configured: st.ai.configured, reason: st.ai.configured ? null : integ?.detail ?? 'No Anthropic API key is configured.' };
  }, [aiState.data]);

  const applyDetail = useCallback(
    (d: ProjectDetail) => {
      // Announce transitions out of an active state.
      for (const v of d.versions) {
        const prev = prevStatuses.current.get(v.id);
        if (prev && isActiveStatus(prev as VersionDTO['status']) && !isActiveStatus(v.status)) {
          if (v.status === 'ready') toast.push({ tone: 'ok', title: `Draft v${v.number} is ready for review`, message: d.project.title });
          else if (v.status === 'failed') toast.push({ tone: 'err', title: `Draft v${v.number} failed`, message: v.error ?? undefined });
        }
        prevStatuses.current.set(v.id, v.status);
      }
      setDetail(d);
    },
    [toast],
  );

  // Transient refresh failures are ignored here: polling (or the next action) recovers, and real
  // problems surface through the action that caused the refresh.
  const refresh = useCallback(async () => {
    try {
      applyDetail(await api.projects.get(id));
    } catch {
      /* keep showing the last good data */
    }
  }, [id, applyDetail]);

  // initial load per project id
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setStep(null);
    setSelectedId(null);
    prevStatuses.current = new Map();
    api.projects
      .get(id)
      .then((d) => {
        if (cancelled) return;
        d.versions.forEach((v) => prevStatuses.current.set(v.id, v.status));
        setDetail(d);
        setLoadError(null);
      })
      .catch((e: Error) => !cancelled && setLoadError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const anyActive = !!detail?.versions.some((v) => isActiveStatus(v.status));
  usePolling(
    async () => {
      applyDetail(await api.projects.get(id));
    },
    1500,
    anyActive,
  );

  useDocumentTitle(detail?.project.title ?? 'Project');

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [step]);

  // Pick the starting step once data arrives.
  useEffect(() => {
    if (!detail || step) return;
    const included = detail.assets.filter((a) => a.kind === 'video' && !a.excluded).length;
    setStep(detail.versions.length ? 'review' : included ? 'brief' : 'footage');
  }, [detail, step]);

  const versions = detail?.versions ?? [];
  // Default to what matters most: something in production, else a draft awaiting review, else the approved one.
  const defaultVersion = versions.find((v) => isActiveStatus(v.status)) ?? versions.find((v) => v.status === 'ready') ?? versions.find((v) => v.status === 'approved') ?? versions[0] ?? null;
  const selected = versions.find((v) => v.id === selectedId) ?? defaultVersion;
  const firstThumb = useMemo(() => detail?.assets.filter((a) => a.kind === 'video' && a.thumbUrl).sort((x, y) => x.sortOrder - y.sortOrder)[0]?.thumbUrl ?? null, [detail]);

  const createDraft = async (instruction: string) => {
    if (!detail) return;
    setCreating(true);
    try {
      const v = await api.versions.create(detail.project.id, instruction ? { instruction } : {});
      toast.success('Draft queued', 'You can watch its progress here.');
      await refresh();
      setSelectedId(v.id);
      setStep('review');
    } catch (e) {
      toast.error(e, 'Could not create the draft');
      if (e instanceof ApiError && e.status === 409) await refresh();
    } finally {
      setCreating(false);
    }
  };

  if (loading && !detail) return <ProjectSkeleton />;
  if (loadError && !detail) {
    const notFound = loadError instanceof ApiError && loadError.status === 404;
    return (
      <div className="page page-narrow">
        <BackLink />
        {notFound ? (
          <EmptyState icon="search" title="Project not found" action={<LinkButton to="/studio">Back to projects</LinkButton>}>
            It may have been removed, or the link is wrong.
          </EmptyState>
        ) : (
          <Callout tone="err" title="Could not load this project">
            <p>{loadError.message}</p>
            <div style={{ marginTop: 8 }}>
              <Button size="sm" icon="refresh" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          </Callout>
        )}
      </div>
    );
  }
  if (!detail || !step) return <ProjectSkeleton />;

  const { project, assets } = detail;
  const archived = project.status === 'archived';
  const videos = assets.filter((a) => a.kind === 'video');
  const included = videos.filter((a) => !a.excluded);
  const latest = versions[0];

  const steps: { id: Step; label: string; sub: string; done: boolean }[] = [
    { id: 'footage', label: 'Footage', sub: videos.length ? `${included.length} of ${plural(videos.length, 'clip')} included` : 'No clips yet', done: included.length > 0 },
    { id: 'brief', label: 'Brief', sub: project.brief.trim() ? 'Brief written' : 'Not written yet', done: !!project.brief.trim() },
    {
      id: 'review',
      label: 'Draft & review',
      sub: latest ? `v${latest.number} · ${versionStatusInfo(latest).label}` : 'No draft yet',
      done: versions.some((v) => v.status === 'ready' || v.status === 'approved'),
    },
  ];

  return (
    <div className="page">
      <BackLink />
      <ProjectHeader project={project} onChanged={refresh} />

      <nav className="stepper" aria-label="Project steps">
        <ol>
          {steps.map((s, i) => (
            <li key={s.id}>
              <button type="button" className={`step${step === s.id ? ' step-on' : ''}${s.done ? ' step-done' : ''}`} aria-current={step === s.id ? 'step' : undefined} onClick={() => setStep(s.id)}>
                <span className="step-n" aria-hidden="true">
                  {s.done && step !== s.id ? <Icon name="check" size="sm" /> : i + 1}
                </span>
                <span className="step-text">
                  <span className="step-label">{s.label}</span>
                  <span className="step-sub">{s.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {/* All panels stay mounted so uploads and unsaved edits survive switching steps. */}
      <div hidden={step !== 'footage'} id="panel-footage">
        <FootageStep
          projectId={project.id}
          assets={assets}
          archived={archived}
          hasVersions={versions.length > 0}
          onChanged={refresh}
          onContinue={() => setStep('brief')}
        />
      </div>
      <div hidden={step !== 'brief'} id="panel-brief">
        <BriefStep
          project={project}
          includedVideos={included.length}
          hasVersions={versions.length > 0}
          active={anyActive}
          onSaved={refresh}
          onCreateDraft={createDraft}
          creating={creating}
        />
      </div>
      <div hidden={step !== 'review'} id="panel-review">
        {versions.length === 0 ? (
          <EmptyState
            icon="studio"
            title="No draft yet"
            action={
              <Button variant="primary" onClick={() => setStep(included.length ? 'brief' : 'footage')}>
                {included.length ? 'Write the brief and create a draft' : 'Add footage first'}
              </Button>
            }
          >
            Once you create a draft, its progress, the playable video, caption and edit details show up here.
          </EmptyState>
        ) : selected ? (
          <div className="review-layout">
            <VersionRail versions={versions} selectedId={selected.id} onSelect={setSelectedId} onCompare={() => setCompare(true)} />
            <div className="review-main">
              <ReviewPanel
                version={selected}
                versions={versions}
                assets={assets}
                posterUrl={firstThumb}
                ai={ai}
                anyActive={anyActive}
                onChanged={refresh}
                onCreated={async (v) => {
                  await refresh();
                  setSelectedId(v.id);
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
      <CompareDialog open={compare} onClose={() => setCompare(false)} versions={versions} initialId={selected?.id ?? null} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/studio" className="backlink">
      <Icon name="arrow-left" size="sm" /> Social Studio
    </Link>
  );
}

function ProjectHeader({ project, onChanged }: { project: ProjectDetail['project']; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const st = PROJECT_STATUS[project.status];
  const fmt = FORMAT_OPTIONS.find((f) => f.id === project.format);

  useEffect(() => setTitle(project.title), [project.title]);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || t === project.title) {
      setEditing(false);
      setTitle(project.title);
      return;
    }
    setBusy(true);
    try {
      await api.projects.patch(project.id, { title: t });
      await onChanged();
      setEditing(false);
    } catch (err) {
      toast.error(err, 'Could not rename');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      if (project.status === 'archived') await api.projects.unarchive(project.id);
      else await api.projects.archive(project.id);
      setArchiveAsk(false);
      toast.success(project.status === 'archived' ? 'Project restored' : 'Project archived', 'No files were deleted.');
      await onChanged();
    } catch (err) {
      toast.error(err, 'Could not change the archive state');
      setArchiveAsk(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="proj-head">
      <div style={{ minWidth: 0, flex: '1 1 320px' }}>
        {editing ? (
          <form className="row-nowrap" onSubmit={rename}>
            <input className="input" style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600 }} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Project title" maxLength={120} autoFocus />
            <Button type="submit" variant="primary" busy={busy}>
              Save
            </Button>
            <Button variant="quiet" onClick={() => { setEditing(false); setTitle(project.title); }}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="row-nowrap" style={{ gap: 4 }}>
            <h1 className="proj-title">{project.title}</h1>
            <IconButton icon="edit" label="Rename project" size="sm" onClick={() => setEditing(true)} />
          </div>
        )}
        <div className="row" style={{ marginTop: 8, gap: 10 }}>
          <StatusPill label={st.label} tone={st.tone} active={project.status === 'processing'} />
          <span className="small muted">
            {styleLabel(project.stylePreset)} · {fmt?.label ?? project.format} · updated {relativeTime(project.updatedAt)}
          </span>
        </div>
      </div>
      <Button variant="quiet" size="sm" icon="archive" onClick={() => (project.status === 'archived' ? void archive() : setArchiveAsk(true))} disabled={busy}>
        {project.status === 'archived' ? 'Unarchive' : 'Archive'}
      </Button>
      <Modal
        open={archiveAsk}
        onClose={() => setArchiveAsk(false)}
        locked={busy}
        title="Archive this project?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setArchiveAsk(false)} disabled={busy}>
              Keep it
            </Button>
            <Button variant="primary" busy={busy} onClick={() => void archive()}>
              Archive
            </Button>
          </>
        }
      >
        <p>It disappears from the main project list. Nothing is deleted: your footage, drafts and exports stay on disk, and you can unarchive it any time.</p>
      </Modal>
    </header>
  );
}

function ProjectSkeleton() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading project">
      <Skeleton w={110} h={14} />
      <div style={{ height: 16 }} />
      <Skeleton w={320} h={34} />
      <div style={{ height: 24 }} />
      <Skeleton h={64} />
      <div style={{ height: 24 }} />
      <Skeleton h={220} />
    </div>
  );
}
