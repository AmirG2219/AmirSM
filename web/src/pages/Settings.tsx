import { useState } from 'react';
import type { IntegrationStatus } from '@shared/api';
import { api } from '../api/client';
import { Badge, Button, Callout, Card, CardHeader, PageHeader, ProgressBar, Skeleton } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useAuth } from '../hooks/auth';
import { useTheme } from '../hooks/theme';
import { useAsync, useDocumentTitle } from '../hooks/hooks';
import { formatBytes, plural, relativeTime, type Tone } from '../lib/format';

const STATE: Record<IntegrationStatus['state'], { label: string; tone: Tone; icon: IconName; blurb: string }> = {
  connected: { label: 'Connected', tone: 'ok', icon: 'circle-check', blurb: 'Configured and available.' },
  not_configured: { label: 'Not connected', tone: 'warn', icon: 'circle-dash', blurb: 'Not set up. The related features are off.' },
  awaiting_credentials: { label: 'Awaiting credentials', tone: 'accent', icon: 'lock', blurb: 'Partly set up; not yet verified against the live service.' },
  fixture: { label: 'Sample data', tone: 'info', icon: 'database', blurb: 'Using local fictional data, not a real service.' },
  error: { label: 'Error', tone: 'err', icon: 'circle-x', blurb: 'Something is wrong.' },
};

const ENV_KEYS: { key: string; what: string }[] = [
  { key: 'ANTHROPIC_API_KEY', what: 'Turns on AI planning, captions, revisions, email help and analysis.' },
  { key: 'AI_WEB_SEARCH_ENABLED', what: 'Set to true to allow market research via Anthropic web search (billed per search).' },
  { key: 'AI_DAILY_CALL_LIMIT / AI_DAILY_TOKEN_LIMIT', what: 'Daily safety limits on AI usage (UTC day).' },
  { key: 'RESEND_API_KEY and RESEND_FROM', what: 'Lets approved emails be delivered (send only; it does not read mail).' },
  { key: 'N8N_BASE_URL, N8N_WEBHOOK_SECRET', what: 'Send events to your n8n instance.' },
  { key: 'N8N_INBOUND_TOKEN', what: 'Lets n8n call this app (long random string).' },
  { key: 'DATA_DIR, MAX_UPLOAD_MB', what: 'Where files live, and the per-file upload limit.' },
];

const fmtUptime = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min ${s % 60} s`;
};

export function Settings() {
  useDocumentTitle('Settings');
  const { data, error, loading, reload } = useAsync((s) => api.settingsStatus(s), []);
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();
  const toast = useToast();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null);

  const n8n = data?.integrations.find((i) => i.id === 'n8n');
  const n8nOff = !n8n || n8n.state === 'not_configured';

  const testN8n = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = (await api.n8nTest()) as { ok?: boolean; detail?: string };
      setTestResult({ ok: !!r?.ok, detail: r?.detail ?? (r?.ok ? 'n8n accepted the test event.' : 'n8n did not accept the test event.') });
      if (r?.ok) toast.success('Test event delivered');
      else toast.push({ tone: 'warn', title: 'Test event not delivered', message: r?.detail });
    } catch (e) {
      toast.error(e, 'Could not send the test event');
      setTestResult({ ok: false, detail: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page page-narrow-wide">
      <PageHeader title="Settings" lede="The honest state of every connection, your AI usage, and where your files live." actions={<Button icon="refresh" onClick={reload}>Refresh</Button>} />

      {error && !data ? (
        <Callout tone="err" title="Could not load status">
          {error.message}
        </Callout>
      ) : loading && !data ? (
        <Skeleton h={240} />
      ) : data ? (
        <div className="stack-l">
          <Card as="section" aria-labelledby="s-int">
            <CardHeader icon="pulse" title={<span id="s-int">Integrations</span>} subtitle="Computed live from your configuration" />
            <ul className="list">
              {data.integrations.map((i) => {
                const st = STATE[i.state];
                return (
                  <li key={i.id} className="sys-item">
                    <div className="row-nowrap" style={{ alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{i.label}</div>
                        <div className="small muted">{i.detail}</div>
                        {i.action ? (
                          <div className="small" style={{ marginTop: 6 }}>
                            <strong>What to do:</strong> {i.action}
                          </div>
                        ) : null}
                      </div>
                      <Badge tone={st.tone} title={st.blurb}>
                        <Icon name={st.icon} size="sm" />
                        {st.label}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card as="section" aria-labelledby="s-ai">
            <CardHeader icon="note" title={<span id="s-ai">AI usage today</span>} subtitle={data.ai.configured ? `Models: ${data.ai.primaryModel} (creative), ${data.ai.fastModel} (light tasks)` : 'AI is not connected, so nothing is being used.'} />
            <div className="card-body stack">
              <Meter label="Calls" used={data.ai.usage.callsToday} limit={data.ai.limits.dailyCalls} />
              <Meter label="Tokens" used={data.ai.usage.tokensToday} limit={data.ai.limits.dailyTokens} />
              <p className="tiny faint">Counted per UTC day. The app refuses AI calls beyond these limits. Figures are the app’s own count, not your Anthropic bill.</p>
              <div>
                <div className="eyebrow">Recent AI calls</div>
                {data.ai.recent.length ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th scope="col">When</th>
                          <th scope="col">Task</th>
                          <th scope="col">Model</th>
                          <th scope="col" className="num">In</th>
                          <th scope="col" className="num">Out</th>
                          <th scope="col">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.ai.recent.map((r, i) => (
                          <tr key={i}>
                            <td className="nowrap">{relativeTime(r.ts)}</td>
                            <td>{r.role.replace(/_/g, ' ')}</td>
                            <td className="mono">{r.model}</td>
                            <td className="num">{r.inputTokens.toLocaleString()}</td>
                            <td className="num">{r.outputTokens.toLocaleString()}</td>
                            <td>{r.ok ? <Badge tone="ok">OK</Badge> : <Badge tone="err" title={r.error}>Failed</Badge>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="small muted" style={{ marginTop: 4 }}>
                    No AI calls have been made yet.
                  </p>
                )}
              </div>
            </div>
          </Card>

          <Card as="section" aria-labelledby="s-store">
            <CardHeader icon="database" title={<span id="s-store">Storage</span>} />
            <div className="card-body stack">
              <dl className="kv">
                <dt>Data folder</dt>
                <dd className="mono" style={{ wordBreak: 'break-all' }}>{data.storage.dataDir}</dd>
                <dt>Uploaded footage</dt>
                <dd>{formatBytes(data.storage.uploadsBytes)}</dd>
                <dt>Rendered drafts</dt>
                <dd>{formatBytes(data.storage.rendersBytes)}</dd>
                <dt>Approved exports</dt>
                <dd>{formatBytes(data.storage.exportsBytes)}</dd>
              </dl>
              <p className="tiny faint">Your original uploads and approved exports are never modified or overwritten by the app.</p>
            </div>
          </Card>

          <Card as="section" aria-labelledby="s-n8n">
            <CardHeader icon="send" title={<span id="s-n8n">n8n automation</span>} subtitle="Optional. The app works fully without it." />
            <div className="card-body stack">
              {n8n ? <p className="small muted">{n8n.detail}</p> : null}
              <div className="row">
                <Button icon="send" busy={testing} disabled={n8nOff} onClick={() => void testN8n()} title={n8nOff ? n8n?.detail : undefined}>
                  Send test event
                </Button>
                {n8nOff ? <span className="small muted">Disabled: n8n is not configured.</span> : null}
              </div>
              {testResult ? (
                <Callout tone={testResult.ok ? 'ok' : 'warn'} title={testResult.ok ? 'n8n accepted the event' : 'n8n did not accept the event'}>
                  {testResult.detail}
                </Callout>
              ) : null}
            </div>
          </Card>

          <Card as="section" aria-labelledby="s-env">
            <CardHeader icon="lock" title={<span id="s-env">Configuration keys</span>} subtitle="Set these in the .env file next to the app, then restart. The app never shows their values." />
            <ul className="list">
              {ENV_KEYS.map((k) => (
                <li key={k.key} className="sys-item">
                  <div className="mono" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{k.key}</div>
                  <div className="small muted">{k.what}</div>
                </li>
              ))}
            </ul>
          </Card>

          <Card as="section" aria-labelledby="s-app">
            <CardHeader icon="settings" title={<span id="s-app">This app</span>} />
            <div className="card-body stack">
              <dl className="kv">
                <dt>Version</dt>
                <dd>{data.app.version}</dd>
                <dt>Node.js</dt>
                <dd>{data.app.node}</dd>
                <dt>Running for</dt>
                <dd>{fmtUptime(data.app.uptimeSeconds)}</dd>
              </dl>
              <hr className="divider" />
              <div className="row">
                <Button icon={theme === 'dark' ? 'sun' : 'moon'} onClick={toggle}>
                  {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                </Button>
                <Button icon="logout" onClick={() => void logout()}>
                  Sign out
                </Button>
              </div>
              <p className="tiny faint">Theme is remembered in this browser only. {plural(data.integrations.length, 'integration')} checked just now.</p>
            </div>
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const frac = limit > 0 ? used / limit : 0;
  return (
    <div className="stack-s" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="small muted">
          {used.toLocaleString()} of {limit.toLocaleString()} used{limit > 0 ? ` (${Math.round(frac * 100)}%)` : ''}
        </span>
      </div>
      <ProgressBar value={Math.min(1, frac)} label={`${label} used today`} />
    </div>
  );
}
