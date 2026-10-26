import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ChatMessageDTO, ProjectDetail, VersionDTO } from '@shared/api';
import { api, ApiError } from '../../api/client';
import { Button, Callout, EmptyState, LinkButton, Skeleton, StatusPill } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAiAvailability } from '../../hooks/ai';
import { useDocumentTitle, usePolling } from '../../hooks/hooks';
import { isActiveStatus, versionStatusInfo, PROJECT_STATUS } from '../../lib/format';
import { Chat } from './Chat';
import { FootageStrip } from './FootageStrip';
import { Preview } from './Preview';

export function Workspace() {
  const { id = '' } = useParams();
  const toast = useToast();
  const ai = useAiAvailability();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'chat' | 'preview'>('chat');
  const prev = useRef<Map<string, string>>(new Map());

  const apply = useCallback(
    (d: ProjectDetail) => {
      for (const v of d.versions) {
        const before = prev.current.get(v.id);
        if (before && isActiveStatus(before as VersionDTO['status']) && !isActiveStatus(v.status)) {
          if (v.status === 'ready') toast.push({ tone: 'ok', title: `Version ${v.number} is ready`, message: 'Take a look in the preview.' });
          else if (v.status === 'failed') toast.push({ tone: 'err', title: `Version ${v.number} could not be finished`, message: v.error ?? undefined });
        }
        prev.current.set(v.id, v.status);
      }
      setDetail(d);
    },
    [toast],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await api.projects.get(id));
    } catch {
      /* keep the last good data; polling or the next action recovers */
    }
  }, [id, apply]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setMessages([]);
    setSelectedId(null);
    setLoadError(null);
    prev.current = new Map();
    Promise.all([api.projects.get(id), api.chat.list(id)])
      .then(([d, m]) => {
        if (cancelled) return;
        d.versions.forEach((v) => prev.current.set(v.id, v.status));
        setDetail(d);
        setMessages(m);
      })
      .catch((e: Error) => !cancelled && setLoadError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const versions = detail?.versions ?? [];
  const anyActive = versions.some((v) => isActiveStatus(v.status));
  usePolling(async () => apply(await api.projects.get(id)), 1500, anyActive);
  useDocumentTitle(detail?.project.title ?? 'Video');

  const defaultVersion = versions.find((v) => isActiveStatus(v.status)) ?? versions.find((v) => v.status === 'ready') ?? versions.find((v) => v.status === 'approved') ?? versions[0] ?? null;
  const selected = versions.find((v) => v.id === selectedId) ?? defaultVersion;
  const poster = useMemo(() => detail?.assets.find((a) => a.role === 'footage' && a.kind === 'video' && a.thumbUrl)?.thumbUrl ?? null, [detail]);

  const archive = async () => {
    try {
      await api.projects.archive(id);
      toast.push({ tone: 'ok', title: 'Archived', message: 'Your clips and exports are kept.' });
      await refresh();
    } catch (e) {
      toast.error(e, 'Could not archive');
    }
  };

  if (loading && !detail) {
    return (
      <div className="ws-page">
        <Skeleton h={44} w="40%" />
        <div style={{ height: 16 }} />
        <Skeleton h={420} />
      </div>
    );
  }
  if (loadError && !detail) {
    const nf = loadError instanceof ApiError && loadError.status === 404;
    return (
      <div className="page page-narrow">
        {nf ? (
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
  if (!detail) return null;

  const p = detail.project;
  const archived = p.status === 'archived';
  const st = PROJECT_STATUS[p.status];

  return (
    <div className="ws-page">
      <header className="ws-head">
        <Link to="/" className="ws-back" aria-label="All videos">
          <Icon name="arrow-left" />
          <span>All videos</span>
        </Link>
        <h1 className="ws-title">{p.title}</h1>
        <StatusPill label={st.label} tone={st.tone} active={p.status === 'processing'} />
        <span className="grow" />
        {!archived ? <Button variant="quiet" size="sm" icon="archive" onClick={archive}>Archive</Button> : null}
      </header>

      <div className="ws-tabs" role="tablist" aria-label="Workspace">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat</button>
        <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
          Preview{selected ? ` · v${selected.number}` : ''}
          {anyActive ? <span className="dotpulse" aria-label="in progress" /> : null}
        </button>
      </div>

      <div className="ws-grid" data-tab={tab}>
        <section className="ws-chat" aria-label="Chat with your video editor">
          <FootageStrip detail={detail} onChanged={refresh} locked={archived} />
          <Chat
            project={p}
            detail={detail}
            messages={messages}
            setMessages={setMessages}
            aiConfigured={ai.configured}
            archived={archived}
            busy={anyActive}
            onChanged={refresh}
            onVersion={(v) => {
              setSelectedId(v.id);
              setTab('preview');
              void refresh();
            }}
            onOpenVersion={(vid) => {
              setSelectedId(vid);
              setTab('preview');
            }}
          />
        </section>

        <aside className="ws-preview" aria-label="Preview">
          {versions.length > 1 ? (
            <div className="vswitch" role="tablist" aria-label="Versions">
              {[...versions].reverse().map((v) => (
                <button key={v.id} role="tab" aria-selected={selected?.id === v.id} className={selected?.id === v.id ? 'on' : ''} onClick={() => setSelectedId(v.id)} title={versionStatusInfo(v).label}>
                  v{v.number}
                  {v.status === 'approved' ? <Icon name="check" /> : null}
                </button>
              ))}
            </div>
          ) : null}
          <Preview version={selected} detail={detail} poster={poster} ai={ai} anyActive={anyActive} onChanged={refresh} onCreated={(v) => { setSelectedId(v.id); void refresh(); }} />
        </aside>
      </div>
    </div>
  );
}
