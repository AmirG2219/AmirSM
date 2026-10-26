import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { LibraryItem } from '@shared/api';
import { api } from '../api/client';
import { Badge, Button, Callout, EmptyState, LinkButton, PageHeader, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { Thumb } from '../components/ProjectCard';
import { useToast } from '../components/Toast';
import { useAsync, useDebounced, useDocumentTitle } from '../hooks/hooks';
import { VERSION_STATUS, formatBytes, formatDuration, relativeTime, type Tone } from '../lib/format';
import { copyText } from '../lib/url';

const KINDS = [
  { id: '', label: 'Everything' },
  { id: 'clip', label: 'Clips' },
  { id: 'draft', label: 'Drafts' },
  { id: 'export', label: 'Final exports' },
];
const STATUSES = [
  { id: '', label: 'Any status' },
  { id: 'preserved', label: 'Clip: kept' },
  { id: 'excluded', label: 'Clip: not in edit' },
  { id: 'ready', label: 'Draft: ready for review' },
  { id: 'superseded', label: 'Draft: superseded' },
  { id: 'approved', label: 'Approved export' },
];

const KIND_LABEL: Record<LibraryItem['kind'], string> = { clip: 'Clip', draft: 'Draft', export: 'Final export' };

function statusInfo(i: LibraryItem): { label: string; tone: Tone } {
  if (i.kind === 'clip') return i.status === 'excluded' ? { label: 'Not in edit', tone: 'warn' } : { label: 'Original kept', tone: 'neutral' };
  const v = (VERSION_STATUS as Record<string, { label: string; tone: Tone }>)[i.status];
  return v ?? { label: i.status, tone: 'neutral' };
}

const isAudio = (t: string) => /\.(mp3|m4a|wav|aac)$/i.test(t);

export function Library() {
  useDocumentTitle('Library');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const { data, error, loading, reload } = useAsync((s) => api.library({ q: dq || undefined, kind: kind || undefined, status: status || undefined }, s), [dq, kind, status]);
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const filtering = !!dq || !!kind || !!status;

  return (
    <div className="page">
      <PageHeader title="Library" lede="Every clip you uploaded, every draft, and every final export, in one searchable place." />

      <div className="filters">
        <div className="search-wrap" style={{ flex: '1 1 260px' }}>
          <Icon name="search" />
          <input className="input input-search" type="search" placeholder="Search file names, project titles, captions and briefs" aria-label="Search the library" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ flex: '0 1 190px' }}>
          <select className="select" aria-label="Filter by type" value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '0 1 220px' }}>
          <select className="select" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && !data ? (
        <Callout tone="err" title="Could not load the library">
          <p>{error.message}</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" icon="refresh" onClick={reload}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : loading && !data ? (
        <div className="pgrid" aria-busy="true" aria-label="Loading library">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card" style={{ overflow: 'hidden' }}>
              <Skeleton h={160} style={{ borderRadius: 0 }} />
              <div style={{ padding: 14 }} className="stack-s">
                <Skeleton w="70%" h={16} />
                <Skeleton w="45%" />
              </div>
            </div>
          ))}
        </div>
      ) : data && data.length === 0 ? (
        filtering ? (
          <EmptyState icon="search" title="Nothing matches" action={<Button onClick={() => { setQ(''); setKind(''); setStatus(''); }}>Clear search and filters</Button>}>
            Try fewer words or another type. Search covers file names, project titles, briefs and captions.
          </EmptyState>
        ) : (
          <EmptyState icon="library" title="Your library is empty" action={<LinkButton to="/studio" variant="primary" icon="studio">Open Social Studio</LinkButton>}>
            Clips you upload, drafts Amir SM renders and approved exports appear here automatically. Start by adding footage to a project.
          </EmptyState>
        )
      ) : data ? (
        <>
          <p className="small muted" style={{ marginBottom: 12 }} aria-live="polite">
            {data.length} {data.length === 1 ? 'item' : 'items'}
            {data.length >= 300 ? ' (showing the 300 most recent)' : ''}
          </p>
          <ul className="pgrid" aria-label="Library items">
            {data.map((i) => (
              <li key={`${i.kind}-${i.id}`}>
                <LibraryCard item={i} onOpen={() => setOpen(i)} />
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <PreviewDialog item={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function LibraryCard({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const st = statusInfo(item);
  const meta = [item.durationMs != null ? formatDuration(item.durationMs) : null, formatBytes(item.sizeBytes)].filter((m) => m && m !== '—').join(' · ');
  const snippet = item.captionText?.split('\n').find((l) => l.trim());
  return (
    <button type="button" className="pcard card lib-card" onClick={onOpen} aria-label={`Preview ${item.title}`}>
      <div className="pcard-media">
        {item.thumbUrl || !isAudio(item.title) ? <Thumb url={item.thumbUrl} ratio="4 / 5" /> : <div className="thumb" style={{ aspectRatio: '4 / 5' }}><Icon name="music" className="thumb-empty" /></div>}
        <div className="pcard-badge">
          <Badge tone={item.kind === 'export' ? 'ok' : item.kind === 'draft' ? 'info' : 'neutral'}>{KIND_LABEL[item.kind]}</Badge>
        </div>
      </div>
      <div className="pcard-body">
        <h3 className="truncate" title={item.title}>
          {item.title}
        </h3>
        <div className="tiny muted truncate">{item.projectTitle}</div>
        <div className="row-nowrap" style={{ gap: 6 }}>
          <Badge tone={st.tone} dot>
            {st.label}
          </Badge>
          {meta ? <span className="tiny faint truncate">{meta}</span> : null}
        </div>
        {snippet ? <div className="small lib-snippet">{snippet}</div> : null}
        <div className="tiny faint">{relativeTime(item.createdAt)}</div>
      </div>
    </button>
  );
}

function PreviewDialog({ item, onClose }: { item: LibraryItem | null; onClose: () => void }) {
  const toast = useToast();
  const st = item ? statusInfo(item) : null;
  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title={item?.title ?? ''}
      footer={
        item ? (
          <>
            {item.downloadUrl ? (
              <a className="btn" href={item.downloadUrl} download>
                <Icon name="download" /> Download {item.kind === 'clip' ? 'original' : 'video'}
              </a>
            ) : null}
            <Link className="btn btn-primary" to={`/studio/${item.projectId}`} onClick={onClose}>
              Open project
            </Link>
          </>
        ) : null
      }
    >
      {item && st ? (
        <div className="stack lib-preview">
          {item.mediaUrl ? (
            <div className="player" style={{ maxHeight: '52vh' }}>
              <video key={item.mediaUrl} controls playsInline preload="metadata" poster={item.thumbUrl ?? undefined} src={item.mediaUrl} style={{ maxHeight: '52vh' }}>
                Your browser can’t play this file. Use the download button.
              </video>
            </div>
          ) : (
            <Callout tone="info">There is no playable file for this item.</Callout>
          )}
          <div className="row" style={{ gap: 8 }}>
            <Badge tone={item.kind === 'export' ? 'ok' : item.kind === 'draft' ? 'info' : 'neutral'}>{KIND_LABEL[item.kind]}</Badge>
            <Badge tone={st.tone} dot>
              {st.label}
            </Badge>
            <span className="small muted">
              {[item.projectTitle, item.durationMs != null ? formatDuration(item.durationMs) : null, formatBytes(item.sizeBytes)].filter((m) => m && m !== '—').join(' · ')}
            </span>
          </div>
          {item.instruction ? (
            <div>
              <div className="eyebrow">Brief / instruction</div>
              <p style={{ marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.instruction}</p>
            </div>
          ) : null}
          {item.captionText ? (
            <div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="eyebrow">Caption</div>
                <Button
                  size="sm"
                  variant="quiet"
                  icon="copy"
                  onClick={async () => ((await copyText(item.captionText!)) ? toast.success('Caption copied') : toast.push({ tone: 'warn', title: 'Could not copy', message: 'Select the text and copy it manually.' }))}
                >
                  Copy
                </Button>
              </div>
              <p className="lib-caption">{item.captionText}</p>
            </div>
          ) : item.kind !== 'clip' ? (
            <p className="small muted">This version has no caption.</p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
