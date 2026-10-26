import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { Button, Callout, EmptyState, Skeleton } from '../../components/ui';
import { ProjectCard } from '../../components/ProjectCard';
import { useToast } from '../../components/Toast';
import { useAsync, useDocumentTitle, usePolling } from '../../hooks/hooks';

export function StudioHome() {
  useDocumentTitle('Social Studio');
  const toast = useToast();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [archived, setArchived] = useState(false);
  const { data, error, loading, reload, setData } = useAsync((s) => api.projects.list({ includeArchived: archived }, s), [archived]);
  usePolling(async () => setData(await api.projects.list({ includeArchived: archived })), 3000, !!data?.some((p) => p.status === 'processing'));
  const list = archived ? data : data?.filter((p) => p.status !== 'archived');

  const start = async () => {
    setCreating(true);
    try {
      const d = await api.projects.create({ title: 'Untitled video' });
      nav(`/studio/${d.project.id}`);
    } catch (e) {
      toast.error(e, 'Could not start a new video');
      setCreating(false);
    }
  };

  return (
    <div className="page page-studio">
      <header className="sh-head">
        <div>
          <h1>Social Studio</h1>
          <p className="lede">Add your clips, tell your editor what to make, and refine it together until it is right.</p>
        </div>
        <Button variant="primary" size="lg" icon="plus" busy={creating} onClick={start}>New video</Button>
      </header>

      {error && !data ? (
        <Callout tone="err" title="Could not load your videos">
          <p>{error.message}</p>
          <div style={{ marginTop: 8 }}><Button size="sm" icon="refresh" onClick={reload}>Try again</Button></div>
        </Callout>
      ) : loading && !data ? (
        <div className="pgrid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i}><Skeleton h={200} /><div style={{ height: 8 }} /><Skeleton w="60%" /></div>
          ))}
        </div>
      ) : list && list.length ? (
        <>
          <ul className="pgrid" aria-label="Your videos">
            {list.map((p) => (
              <li key={p.id}><ProjectCard p={p} /></li>
            ))}
          </ul>
          <label className="check tiny muted sh-archived">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
        </>
      ) : (
        <div className="sh-empty">
          <EmptyState icon="film" title="Make your first video" center action={<Button variant="primary" size="lg" icon="plus" busy={creating} onClick={start}>New video</Button>}>
            You will chat with an editor that cuts your clips into a vertical video, writes the caption, and improves it with your feedback.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
