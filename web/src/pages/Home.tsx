import { Link } from 'react-router-dom';
import type { DashboardDTO, SystemStatusItem } from '@shared/api';
import { api } from '../api/client';
import { Badge, Button, Callout, Card, LinkButton, CardHeader, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { ProjectRow } from '../components/ProjectCard';
import { useAsync, useDocumentTitle, usePolling } from '../hooks/hooks';
import { plural, relativeTime, type Tone } from '../lib/format';

const SYSTEM_STATE: Record<SystemStatusItem['state'], { label: string; tone: Tone; icon: IconName }> = {
  ok: { label: 'Working', tone: 'ok', icon: 'circle-check' },
  fixture: { label: 'Sample data', tone: 'info', icon: 'info' },
  not_configured: { label: 'Not connected', tone: 'warn', icon: 'circle-dash' },
  degraded: { label: 'Degraded', tone: 'warn', icon: 'alert' },
  error: { label: 'Error', tone: 'err', icon: 'circle-x' },
};

function SectionLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className="small" style={{ whiteSpace: 'nowrap' }}>
      {children}
    </Link>
  );
}

function Loading() {
  return (
    <div className="stack-l" aria-busy="true" aria-label="Loading dashboard">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="card-pad">
          <Skeleton w={180} h={18} />
          <div style={{ height: 14 }} />
          <Skeleton h={48} />
        </Card>
      ))}
    </div>
  );
}

export function Home() {
  useDocumentTitle('Home');
  const { data, error, loading, reload, setData } = useAsync((s) => api.dashboard(s), []);

  const busy = !!data && (data.inProgress.length > 0 || data.queue.queued + data.queue.running > 0);
  usePolling(async () => setData(await api.dashboard()), 3000, busy);

  return (
    <div className="page">
      <PageHeader
        title="Home"
        lede="What is in production, what needs your eye, and the honest state of every connection."
        actions={
          <LinkButton to="/studio?new=1" variant="primary" icon="plus">
            New project
          </LinkButton>
        }
      />

      {error && !data ? (
        <Callout tone="err" title="Could not load the dashboard">
          <p>{error.message}</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" icon="refresh" onClick={reload}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : loading && !data ? (
        <Loading />
      ) : data ? (
        <Dashboard d={data} />
      ) : null}
    </div>
  );
}

function Dashboard({ d }: { d: DashboardDTO }) {
  const processing = d.queue.queued + d.queue.running;
  return (
    <div className="home-grid">
      <Card as="section" className="span-12" aria-labelledby="h-progress">
        <CardHeader
          icon="pulse"
          title={<span id="h-progress">Video projects in production</span>}
          subtitle={processing > 0 ? `${d.queue.running} running · ${d.queue.queued} queued` : 'Nothing is being rendered right now.'}
          actions={<SectionLink to="/studio">Open Studio</SectionLink>}
        />
        {d.inProgress.length ? (
          <ul className="list" aria-live="polite">
            {d.inProgress.map((p) => (
              <ProjectRow key={p.id} p={p} showProgress />
            ))}
          </ul>
        ) : (
          <div className="card-body">
            <EmptyState compact title="No video is in production">
              Open a project, add footage and press “Create draft” to start one.
            </EmptyState>
          </div>
        )}
      </Card>

      <Card as="section" className="span-6" aria-labelledby="h-review">
        <CardHeader icon="eye" title={<span id="h-review">Videos needing review</span>} />
        {d.needsReview.length ? (
          <ul className="list">
            {d.needsReview.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <div className="card-body">
            <EmptyState compact title="Nothing is waiting for review">
              Finished drafts that need your approval will appear here.
            </EmptyState>
          </div>
        )}
      </Card>

      <Card as="section" className="span-6" aria-labelledby="h-done">
        <CardHeader icon="circle-check" title={<span id="h-done">Recently completed</span>} />
        {d.recentlyCompleted.length ? (
          <ul className="list">
            {d.recentlyCompleted.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <div className="card-body">
            <EmptyState compact title="No approved videos yet">
              Approve a draft in Social Studio and its exported copy will be listed here.
            </EmptyState>
          </div>
        )}
      </Card>

      <Card as="section" className="span-6" aria-labelledby="h-email">
        <CardHeader
          icon="mail"
          title={<span id="h-email">Pending email actions</span>}
          actions={
            <>
              {d.pendingEmail.isFixture ? (
                <Badge tone="info" title="These messages are fictional sample data stored locally. No real mailbox is connected.">
                  Local sample mailbox
                </Badge>
              ) : null}
              <SectionLink to="/email">Email</SectionLink>
            </>
          }
        />
        <div className="card-body stack">
          {d.pendingEmail.isFixture ? (
            <p className="small muted">
              Showing the <strong>local sample mailbox</strong>: fictional messages, not your real inbox. Nothing is sent from here.
            </p>
          ) : d.pendingEmail.provider === 'none' ? (
            <p className="small muted">No mailbox is connected.</p>
          ) : (
            <p className="small muted">Mailbox: {d.pendingEmail.provider}</p>
          )}
          {d.pendingEmail.drafts.length === 0 && d.pendingEmail.needsReplyThreads.length === 0 ? (
            <EmptyState compact title="No email actions pending">
              No drafts are waiting for approval and no threads are flagged as needing a reply.
            </EmptyState>
          ) : (
            <>
              {d.pendingEmail.needsReplyThreads.length ? (
                <div>
                  <div className="eyebrow">Needs a reply · {d.pendingEmail.needsReplyThreads.length}</div>
                  <ul className="plain-list">
                    {d.pendingEmail.needsReplyThreads.map((t) => (
                      <li key={t.id}>
                        <span className="truncate">{t.subject || '(no subject)'}</span>
                        <span className="tiny faint nowrap">{relativeTime(t.lastMessageAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {d.pendingEmail.drafts.length ? (
                <div>
                  <div className="eyebrow">Drafts · {d.pendingEmail.drafts.length}</div>
                  <ul className="plain-list">
                    {d.pendingEmail.drafts.map((x) => (
                      <li key={x.id}>
                        <span className="truncate">{x.subject}</span>
                        <Badge tone={x.status === 'approved' ? 'ok' : x.status === 'failed' ? 'err' : 'neutral'}>{x.status}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Card>

      <Card as="section" className="span-6" aria-labelledby="h-research">
        <CardHeader icon="research" title={<span id="h-research">Recent research findings</span>} actions={<SectionLink to="/research">Research</SectionLink>} />
        <div className="card-body">
          {d.recentResearch.length ? (
            <ul className="plain-list">
              {d.recentResearch.map((r) => (
                <li key={r.id}>
                  <span className="truncate">
                    <Badge outline>{r.kind.replace(/_/g, ' ')}</Badge> <span style={{ marginLeft: 6 }}>{r.title}</span>
                  </span>
                  <span className="tiny faint nowrap">{relativeTime(r.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No research saved yet">
              Competitor notes, ideas and analyses you save will show up here. The Research workspace arrives in phase 2.
            </EmptyState>
          )}
        </div>
      </Card>

      <Card as="section" className="span-6" aria-labelledby="h-system">
        <CardHeader icon="settings" title={<span id="h-system">System and processing status</span>} />
        <ul className="list">
          {d.system.map((s) => {
            const st = SYSTEM_STATE[s.state];
            return (
              <li key={s.id} className="sys-item">
                <div className="row-nowrap" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{s.label}</div>
                    <div className="small muted">{s.detail}</div>
                  </div>
                  <Badge tone={st.tone}>
                    <Icon name={st.icon} size="sm" />
                    {st.label}
                  </Badge>
                </div>
              </li>
            );
          })}
          <li className="sys-item">
            <div className="row-nowrap">
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>Render queue</div>
                <div className="small muted">
                  {processing === 0 ? 'Idle' : `${plural(d.queue.running, 'job')} running, ${plural(d.queue.queued, 'job')} waiting`}
                </div>
              </div>
              <Badge tone={processing === 0 ? 'neutral' : 'accent'} spinner={processing > 0}>
                {processing === 0 ? 'Idle' : 'Busy'}
              </Badge>
            </div>
          </li>
        </ul>
      </Card>

      <Card as="section" className="span-6" aria-labelledby="h-fail">
        <CardHeader icon="alert" title={<span id="h-fail">Recent failures</span>} subtitle="Last 7 days" />
        {d.recentFailures.length ? (
          <ul className="list">
            {d.recentFailures.map((f) => (
              <li key={f.versionId}>
                <Link to={`/studio/${f.projectId}`} className="prow">
                  <div className="prow-main">
                    <div className="prow-title truncate">
                      {f.projectTitle} · v{f.number}
                    </div>
                    <div className="small" style={{ color: 'var(--err)' }}>
                      {f.error ?? 'Failed without an error message.'}
                    </div>
                    <div className="tiny faint">{relativeTime(f.at)}</div>
                  </div>
                  <Icon name="chevron-right" className="faint" />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="card-body">
            <EmptyState compact title="No failed drafts">
              Nothing has failed in the last 7 days.
            </EmptyState>
          </div>
        )}
      </Card>

      <Card as="section" className="span-12" aria-labelledby="h-activity">
        <CardHeader icon="list" title={<span id="h-activity">Activity</span>} subtitle="Recorded by the app as things happen" />
        <div className="card-body">
          {d.activity.length ? (
            <ol className="activity">
              {d.activity.map((a) => (
                <li key={a.id}>
                  <span className="tiny faint nowrap" title={new Date(a.ts).toLocaleString()}>
                    {relativeTime(a.ts)}
                  </span>
                  <span>
                    {a.projectId ? (
                      <Link to={`/studio/${a.projectId}`} className="activity-link">
                        {a.message}
                      </Link>
                    ) : (
                      a.message
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState compact title="No activity yet">
              Creating projects, uploading clips and approving drafts will be listed here as they happen.
            </EmptyState>
          )}
        </div>
      </Card>
    </div>
  );
}
