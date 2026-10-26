import type { IntegrationStatus } from '@shared/api';
import { api } from '../api/client';
import { Badge, Button, Callout, ProgressBar, Skeleton } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { useAuth } from '../hooks/auth';
import { useTheme } from '../hooks/theme';
import { useAsync, useDocumentTitle } from '../hooks/hooks';
import { formatBytes, type Tone } from '../lib/format';

const STATE: Record<IntegrationStatus['state'], { label: string; tone: Tone; icon: IconName }> = {
  connected: { label: 'Connected', tone: 'ok', icon: 'circle-check' },
  not_configured: { label: 'Not connected', tone: 'warn', icon: 'circle-dash' },
  fixture: { label: 'Sample data', tone: 'info', icon: 'database' },
  error: { label: 'Error', tone: 'err', icon: 'circle-x' },
};

export function Settings() {
  useDocumentTitle('Settings');
  const { data, error, loading, reload } = useAsync((s) => api.settingsStatus(s), []);
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="lede">What is connected, how much AI you have used today, and where your files live.</p>
        </div>
      </header>

      {error && !data ? (
        <Callout tone="err" title="Could not load status">
          <p>{error.message}</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" icon="refresh" onClick={reload}>Try again</Button>
          </div>
        </Callout>
      ) : loading && !data ? (
        <Skeleton h={240} />
      ) : data ? (
        <div className="stack-l">
          <section aria-labelledby="s-int" className="settings-sec">
            <h2 id="s-int" className="block-title">Connections</h2>
            <ul className="list">
              {data.integrations.map((i) => {
                const st = STATE[i.state];
                return (
                  <li key={i.id} className="sys-item">
                    <div className="row-nowrap" style={{ alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{i.label}</div>
                        <div className="small muted">{i.detail}</div>
                        {i.action ? <div className="small" style={{ marginTop: 6 }}><strong>What to do:</strong> {i.action}</div> : null}
                      </div>
                      <Badge tone={st.tone}>
                        <Icon name={st.icon} size="sm" />
                        {st.label}
                      </Badge>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="s-ai" className="settings-sec">
            <h2 id="s-ai" className="block-title">AI usage today</h2>
            {data.ai.configured ? (
              <p className="small muted">Models: {data.ai.primaryModel} for editing, {data.ai.fastModel} for lighter tasks.</p>
            ) : (
              <p className="small muted">AI is off, so nothing is being used. You can still make videos with the Basic auto-edit.</p>
            )}
            <div className="stack" style={{ marginTop: 'var(--s-3)' }}>
              <Meter label="Calls" used={data.ai.usage.callsToday} limit={data.ai.limits.dailyCalls} />
              <Meter label="Tokens" used={data.ai.usage.tokensToday} limit={data.ai.limits.dailyTokens} />
            </div>
            <p className="tiny faint" style={{ marginTop: 10 }}>Counted per UTC day. The app refuses AI calls beyond these limits. This is the app’s own count, not your Anthropic bill.</p>
          </section>

          <section aria-labelledby="s-store" className="settings-sec">
            <h2 id="s-store" className="block-title">Storage</h2>
            <dl className="kv">
              <dt>Data folder</dt>
              <dd className="mono" style={{ wordBreak: 'break-all' }}>{data.storage.dataDir}</dd>
              <dt>Your clips</dt>
              <dd>{formatBytes(data.storage.uploadsBytes)}</dd>
              <dt>Drafts</dt>
              <dd>{formatBytes(data.storage.rendersBytes)}</dd>
              <dt>Approved exports</dt>
              <dd>{formatBytes(data.storage.exportsBytes)}</dd>
            </dl>
            <p className="tiny faint" style={{ marginTop: 10 }}>Your original clips and approved exports are never modified or overwritten.</p>
          </section>

          <section aria-labelledby="s-app" className="settings-sec">
            <h2 id="s-app" className="block-title">This device</h2>
            <div className="row">
              <Button icon={theme === 'dark' ? 'sun' : 'moon'} onClick={toggle}>
                {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              </Button>
              <Button icon="logout" onClick={() => void logout()}>Sign out</Button>
            </div>
            <p className="tiny faint" style={{ marginTop: 10 }}>Amir SM {data.app.version}. The theme is remembered in this browser only.</p>
          </section>
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
          {used.toLocaleString()} of {limit.toLocaleString()}{limit > 0 ? ` (${Math.round(frac * 100)}%)` : ''}
        </span>
      </div>
      <ProgressBar value={Math.min(1, frac)} label={`${label} used today`} />
    </div>
  );
}
