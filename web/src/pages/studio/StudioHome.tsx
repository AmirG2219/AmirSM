import { useState } from 'react';
import { api } from '../../api/client';
import { Button, Callout, Skeleton } from '../../components/ui';
import { ProjectCard } from '../../components/ProjectCard';
import { useAsync, useDocumentTitle, usePolling } from '../../hooks/hooks';
import { Composer } from './Composer';

export function StudioHome() {
  useDocumentTitle('Social Studio');
  const [archived, setArchived] = useState(false);
  const { data, error, loading, reload, setData } = useAsync((s) => api.projects.list({ includeArchived: archived }, s), [archived]);

  const anyProcessing = !!data?.some((p) => p.status === 'processing');
  usePolling(async () => setData(await api.projects.list({ includeArchived: archived })), 3000, anyProcessing);

  const list = archived ? data : data?.filter((p) => p.status !== 'archived');

  return (
    <div className="page page-studio">
      <Composer />

      <section className="past" aria-labelledby="past-h">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--s-4)' }}>
          <h2 id="past-h" className="section-title">Your videos</h2>
          <label className="check tiny muted">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
        {error && !data ? (
          <Callout tone="err" title="Could not load your videos">
            <p>{error.message}</p>
            <div style={{ marginTop: 8 }}>
              <Button size="sm" icon="refresh" onClick={reload}>Try again</Button>
            </div>
          </Callout>
        ) : loading && !data ? (
          <div className="pgrid" aria-busy="true" aria-label="Loading your videos">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <Skeleton h={200} />
                <div style={{ height: 8 }} />
                <Skeleton w="60%" />
              </div>
            ))}
          </div>
        ) : list && list.length ? (
          <ul className="pgrid" aria-label="Your videos">
            {list.map((p) => (
              <li key={p.id}>
                <ProjectCard p={p} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Your finished videos will appear here.</p>
        )}
      </section>
    </div>
  );
}
