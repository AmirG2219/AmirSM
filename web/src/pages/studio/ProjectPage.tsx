import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProjectDetail, VersionDTO } from '@shared/api';
import { ApiError, api, uploadFile } from '../../api/client';
import { Badge, Button, Callout, EmptyState, IconButton, LinkButton, Skeleton, StatusPill } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { Thumb } from '../../components/ProjectCard';
import { useToast } from '../../components/Toast';
import { useAiAvailability } from '../../hooks/ai';
import { useDocumentTitle, usePolling } from '../../hooks/hooks';
import { PROJECT_STATUS, formatBytes, formatDuration, isActiveStatus, plural, versionStatusInfo } from '../../lib/format';
import { VIDEO_EXT, extOf } from '../../lib/studio';
import { FailedView, PlanSourceBadge, ProgressView, ReadyView } from './ReviewView';

export function ProjectPage() {
  const { id = '' } = useParams();
  const toast = useToast();
  const ai = useAiAvailability();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const prevStatuses = useRef<Map<string, string>>(new Map());

  const applyDetail = useCallback(
    (d: ProjectDetail) => {
      for (const v of d.versions) {
        const prev = prevStatuses.current.get(v.id);
        if (prev && isActiveStatus(prev as VersionDTO['status']) && !isActiveStatus(v.status)) {
          if (v.status === 'ready') toast.push({ tone: 'ok', title: `Version ${v.number} is ready to review`, message: d.project.title });
          else if (v.status === 'failed') toast.push({ tone: 'err', title: `Version ${v.number} could not be finished`, message: v.error ?? undefined });
        }
        prevStatuses.current.set(v.id, v.status);
      }
      setDetail(d);
    },
    [toast],
  );

  // Transient refresh failures are ignored; polling or the next action recovers.
  const refresh = useCallback(async () => {
    try {
      applyDetail(await api.projects.get(id));
    } catch {
      /* keep showing the last good data */
    }
  }, [id, applyDetail]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setSelectedId(null);
    setLoadError(null);
    prevStatuses.current = new Map();
    api.projects
      .get(id)
      .then((d) => {
        if (cancelled) return;
        d.versions.forEach((v) => prevStatuses.current.set(v.id, v.status));
        setDetail(d);
      })
      .catch((e: Error) => !cancelled && setLoadError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const anyActive = !!detail?.versions.some((v) => isActiveStatus(v.status));
  usePolling(async () => applyDetail(await api.projects.get(id)), 1500, anyActive);
  useDocumentTitle(detail?.project.title ?? 'Video');

  const versions = detail?.versions ?? [];
  // Prefer: something in production, else a version awaiting review, else the approved one, else the newest.
  const defaultVersion = versions.find((v) => isActiveStatus(v.status)) ?? versions.find((v) => v.status === 'ready') ?? versions.find((v) => v.status === 'approved') ?? versions[0] ?? null;
  const selected = versions.find((v) => v.id === selectedId) ?? defaultVersion;
  const firstThumb = useMemo(() => detail?.assets.filter((a) => a.kind === 'video' && a.thumbUrl).sort((x, y) => x.sortOrder - y.sortOrder)[0]?.thumbUrl ?? null, [detail]);

  if (loading && !detail) return <Skeletons />;
  if (loadError && !detail) {
    const notFound = loadError instanceof ApiError && loadError.status === 404;
    return (
      <div className="page page-narrow">
        <BackLink />
        {notFound ? (
          <EmptyState icon="search" title="Video not found" action={<LinkButton to="/">Back to Social Studio</LinkButton>}>
            It may have been removed, or the link is wrong.
          </EmptyState>
        ) : (
          <Callout tone="err" title="Could not load this video">
            <p>{loadError.message}</p>
            <div style={{ marginTop: 8 }}>
              <Button size="sm" icon="refresh" onClick={() => window.location.reload()}>Try again</Button>
            </div>
          </Callout>
        )}
      </div>
    );
  }
  if (!detail) return <Skeletons />;

  const { project, assets } = detail;
  const hasOutput = !!selected?.output && ['ready', 'approved', 'superseded'].includes(selected.status);

  return (
    <div className="page page-project">
      <BackLink />
      <ProjectHeader project={project} onChanged={refresh} />

      {versions.length > 1 ? (
        <nav className="switcher" aria-label="Versions">
          {[...versions].reverse().map((v) => {
            const st = versionStatusInfo(v);
            return (
              <button key={v.id} type="button" className={`vchip${selected?.id === v.id ? ' vchip-on' : ''}`} aria-current={selected?.id === v.id ? 'true' : undefined} onClick={() => setSelectedId(v.id)} title={`${st.label}${v.instruction ? ': ' + v.instruction : ''}`}>
                v{v.number}
                <span className={`vdot vdot-${v.approved ? 'ok' : st.tone}`} aria-hidden="true" />
                <span className="sr-only">{st.label}</span>
              </button>
            );
          })}
        </nav>
      ) : null}

      {!selected ? (
        <EmptyState icon="film" title="Nothing has been made yet" action={<LinkButton to="/" variant="primary">Make a video</LinkButton>}>
          This project has no versions. Start a new video from Social Studio.
        </EmptyState>
      ) : (
        <>
          <div className="version-head">
            <h2 className="version-title">Version {selected.number}</h2>
            {selected.planSource ? <PlanSourceBadge source={selected.planSource} /> : null}
            {selected.approved ? <Badge tone="ok">Approved</Badge> : null}
            {selected.isRevision && selected.instruction ? <span className="small muted truncate" style={{ flex: '1 1 200px', minWidth: 0 }} title={selected.instruction}>“{selected.instruction}”</span> : null}
          </div>

          {isActiveStatus(selected.status) ? (
            <ProgressView version={selected} onChanged={refresh} />
          ) : selected.status === 'failed' || selected.status === 'cancelled' ? (
            <FailedView version={selected} onChanged={refresh} anyOtherActive={anyActive} />
          ) : hasOutput ? (
            <ReadyView
              version={selected}
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
          ) : null}
        </>
      )}

      <ClipsSection detail={detail} onChanged={refresh} locked={anyActive} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/" className="backlink">
      <Icon name="arrow-left" size="sm" /> Social Studio
    </Link>
  );
}

function Skeletons() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading">
      <Skeleton w={110} h={14} />
      <div style={{ height: 16 }} />
      <Skeleton w={320} h={34} />
      <div style={{ height: 24 }} />
      <Skeleton h={320} />
    </div>
  );
}

/* ---------- Header ---------- */
function ProjectHeader({ project, onChanged }: { project: ProjectDetail['project']; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [busy, setBusy] = useState(false);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const st = PROJECT_STATUS[project.status];

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
      toast.success(project.status === 'archived' ? 'Restored' : 'Archived', 'No files were deleted.');
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
            <input className="input" style={{ fontSize: 22, fontFamily: 'var(--font-display)', fontWeight: 600 }} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" maxLength={120} autoFocus />
            <Button type="submit" variant="primary" busy={busy}>Save</Button>
            <Button variant="quiet" onClick={() => { setEditing(false); setTitle(project.title); }}>Cancel</Button>
          </form>
        ) : (
          <div className="row-nowrap" style={{ gap: 4 }}>
            <h1 className="proj-title">{project.title}</h1>
            <IconButton icon="edit" label="Rename" size="sm" onClick={() => setEditing(true)} />
          </div>
        )}
        <div style={{ marginTop: 8 }}>
          <StatusPill label={st.label} tone={st.tone} active={project.status === 'processing'} />
        </div>
      </div>
      <Button variant="quiet" size="sm" icon="archive" onClick={() => (project.status === 'archived' ? void archive() : setArchiveAsk(true))} disabled={busy}>
        {project.status === 'archived' ? 'Unarchive' : 'Archive'}
      </Button>
      <Modal
        open={archiveAsk}
        onClose={() => setArchiveAsk(false)}
        locked={busy}
        title="Archive this video?"
        footer={
          <>
            <Button variant="quiet" onClick={() => setArchiveAsk(false)} disabled={busy}>Keep it</Button>
            <Button variant="primary" busy={busy} onClick={() => void archive()}>Archive</Button>
          </>
        }
      >
        <p>It moves out of your main list. Nothing is deleted: your clips, versions and exports stay on disk, and you can unarchive it any time.</p>
      </Modal>
    </header>
  );
}

/* ---------- Clips (collapsed; add / include / order) ---------- */
function ClipsSection({ detail, onChanged, locked }: { detail: ProjectDetail; onChanged: () => Promise<void>; locked: boolean }) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const archived = detail.project.status === 'archived';
  const videos = detail.assets.filter((a) => a.kind === 'video').sort((a, b) => a.sortOrder - b.sortOrder);
  const included = videos.filter((a) => !a.excluded).length;

  const toggle = async (id: string, excluded: boolean) => {
    setBusyId(id);
    try {
      await api.assets.patch(id, { excluded: !excluded });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not update the clip');
    } finally {
      setBusyId(null);
    }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    const a = videos[idx];
    const b = videos[j];
    if (!a || !b) return;
    setBusyId(a.id);
    try {
      await api.assets.patch(a.id, { sortOrder: b.sortOrder });
      await api.assets.patch(b.id, { sortOrder: a.sortOrder });
    } catch (e) {
      toast.error(e, 'Could not reorder');
    } finally {
      await onChanged();
      setBusyId(null);
    }
  };

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    const errs: string[] = [];
    const list = Array.from(files);
    for (let i = 0; i < list.length; i++) {
      const f = list[i]!;
      const ext = extOf(f.name);
      if (!VIDEO_EXT.includes(ext)) {
        errs.push(`${f.name}: unsupported file type.`);
        continue;
      }
      setAdding(`Uploading ${i + 1} of ${list.length}…`);
      try {
        const r = await uploadFile(detail.project.id, f, () => undefined).promise;
        if (!r.ok) errs.push(`${f.name}: ${r.error ?? 'rejected by the server'}`);
        else await onChanged();
      } catch (e) {
        errs.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    setAdding(null);
    setErrors(errs);
  };

  return (
    <details className="disclosure clips-section">
      <summary>
        Your clips
        <span className="tiny muted" style={{ fontWeight: 400 }}>{included} of {plural(videos.length, 'clip')} included</span>
      </summary>
      <div className="disclosure-body stack">
        <p className="small muted">Changes here apply to the next version you make (request changes above). Existing versions are not re-rendered.</p>
        <ol className="clipl">
          {videos.map((a, i) => (
            <li key={a.id} className={a.excluded ? 'clipl-off' : ''}>
              <div className="clipl-thumb"><Thumb url={a.thumbUrl} ratio="9 / 16" /></div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="truncate" style={{ fontWeight: 600 }} title={a.originalName}>{a.originalName}</div>
                <div className="tiny muted">{formatDuration(a.info.durationMs)} · {a.info.displayWidth || a.info.width}×{a.info.displayHeight || a.info.height} · {formatBytes(a.sizeBytes)} · {a.info.hasAudio ? 'has audio' : 'no audio'}</div>
              </div>
              <label className="check" title="Include in the edit">
                <input type="checkbox" checked={!a.excluded} disabled={busyId !== null || archived || locked} onChange={() => void toggle(a.id, a.excluded)} />
                <span className="sr-only">Include {a.originalName}</span>
                <span aria-hidden="true" className="tiny">Include</span>
              </label>
              <div className="row-nowrap" style={{ gap: 0 }}>
                <IconButton icon="arrow-up" label={`Move ${a.originalName} earlier`} size="sm" disabled={i === 0 || busyId !== null || archived || locked} onClick={() => void move(i, -1)} />
                <IconButton icon="arrow-down" label={`Move ${a.originalName} later`} size="sm" disabled={i === videos.length - 1 || busyId !== null || archived || locked} onClick={() => void move(i, 1)} />
              </div>
            </li>
          ))}
        </ol>
        <div className="row">
          <Button size="sm" icon="plus" busy={!!adding} disabled={archived || locked} onClick={() => input.current?.click()}>Add clips</Button>
          {adding ? <span className="small muted" role="status">{adding}</span> : null}
        </div>
        <input ref={input} type="file" multiple accept={`${VIDEO_EXT.join(',')},video/*`} className="sr-only" tabIndex={-1} aria-label="Choose clips to add" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        {errors.length ? (
          <ul className="rejects" role="alert">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
