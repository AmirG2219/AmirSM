import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { OutputFormat, StylePreset } from '@shared/editPlan';
import { api } from '../../api/client';
import { Button, Callout, EmptyState, Input, PageHeader, Select, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ProjectCard } from '../../components/ProjectCard';
import { useToast } from '../../components/Toast';
import { useAsync, useDebounced, useDocumentTitle, usePolling } from '../../hooks/hooks';
import { FORMAT_OPTIONS, STYLE_OPTIONS } from '../../lib/format';

const FILTERS = [
  { id: '', label: 'All active projects' },
  { id: 'draft', label: 'Draft' },
  { id: 'processing', label: 'In production' },
  { id: 'review', label: 'Needs review' },
  { id: 'approved', label: 'Approved' },
  { id: 'failed', label: 'Failed' },
  { id: 'archived', label: 'Archived' },
];

export function StudioList() {
  useDocumentTitle('Social Studio');
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const { data, error, loading, reload, setData } = useAsync((s) => api.projects.list({ q: dq || undefined, status: status || undefined }, s), [dq, status]);

  const anyProcessing = !!data?.some((p) => p.status === 'processing');
  usePolling(async () => setData(await api.projects.list({ q: dq || undefined, status: status || undefined })), 3000, anyProcessing);

  const creating = params.get('new') === '1';
  const closeNew = () => {
    const p = new URLSearchParams(params);
    p.delete('new');
    setParams(p, { replace: true });
  };

  const filtering = !!dq || !!status;

  return (
    <div className="page">
      <PageHeader
        title="Social Studio"
        lede="Turn your own footage into a finished short-form video: upload, brief, review, approve."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setParams({ new: '1' })}>
            New project
          </Button>
        }
      />

      <div className="filters">
        <div className="search-wrap" style={{ flex: '1 1 260px' }}>
          <Icon name="search" />
          <input className="input input-search" type="search" placeholder="Search projects by title or brief" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ flex: '0 1 220px' }}>
          <select className="select" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && !data ? (
        <Callout tone="err" title="Could not load projects">
          <p>{error.message}</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" icon="refresh" onClick={reload}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : loading && !data ? (
        <div className="pgrid" aria-busy="true" aria-label="Loading projects">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <Skeleton h={180} style={{ borderRadius: 0 }} />
              <div style={{ padding: 16 }} className="stack-s">
                <Skeleton w="70%" h={16} />
                <Skeleton w="45%" />
              </div>
            </div>
          ))}
        </div>
      ) : data && data.length === 0 ? (
        filtering ? (
          <EmptyState icon="search" title="No projects match" action={<Button onClick={() => { setQ(''); setStatus(''); }}>Clear search and filter</Button>}>
            Try a different search, or clear the filter to see every active project.
          </EmptyState>
        ) : (
          <EmptyState
            icon="studio"
            title="Start your first video project"
            action={
              <Button variant="primary" icon="plus" onClick={() => setParams({ new: '1' })}>
                New project
              </Button>
            }
          >
            A project holds your footage, your brief and every version of the edit. Nothing here is pre-filled: you add the clips, Amir SM assembles them.
          </EmptyState>
        )
      ) : data ? (
        <ul className="pgrid" aria-label="Projects">
          {data.map((p) => (
            <li key={p.id}>
              <ProjectCard p={p} />
            </li>
          ))}
        </ul>
      ) : null}

      <NewProjectDialog open={creating} onClose={closeNew} />
    </div>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [style, setStyle] = useState<StylePreset>('calm-cinematic');
  const [format, setFormat] = useState<OutputFormat>('9:16');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErr('Give the project a title.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const d = await api.projects.create({ title: title.trim(), stylePreset: style, format });
      toast.success('Project created', 'Add your footage to get started.');
      setTitle('');
      onClose();
      nav(`/studio/${d.project.id}`);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      locked={busy}
      title="New project"
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="new-project-form" busy={busy}>
            Create project
          </Button>
        </>
      }
    >
      <form id="new-project-form" className="stack" onSubmit={submit} noValidate>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Sunday market day" maxLength={120} autoFocus error={err ?? undefined} />
        <Select label="Style" value={style} onChange={(e) => setStyle(e.target.value as StylePreset)} hint={STYLE_OPTIONS.find((s) => s.id === style)?.blurb}>
          {STYLE_OPTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)} hint={FORMAT_OPTIONS.find((f) => f.id === format)?.blurb}>
          {FORMAT_OPTIONS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </Select>
      </form>
    </Modal>
  );
}
