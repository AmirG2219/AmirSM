import { useEffect, useState } from 'react';
import type { EmailAccountDTO, EmailThreadDetail } from '@shared/api';
import { api } from '../api/client';
import { Badge, Button, Callout, EmptyState, PageHeader, Skeleton, Tabs } from '../components/ui';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toast';
import { useAiAvailability } from '../hooks/ai';
import { useAsync, useDebounced, useDocumentTitle } from '../hooks/hooks';
import { formatDateTime, relativeTime } from '../lib/format';
import { ComposePanel, draftStatusBadge, type ComposeSeed } from './EmailCompose';

type Tab = 'inbox' | 'drafts';
type View = { kind: 'list' } | { kind: 'compose'; seed: ComposeSeed; key: number };

export function Email() {
  useDocumentTitle('Email');
  const accounts = useAsync((s) => api.email.accounts(s), []);
  const ai = useAiAvailability();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [composeKey, setComposeKey] = useState(0);
  const drafts = useAsync((s) => api.email.drafts(s), []);

  const list = accounts.data;
  useEffect(() => {
    if (list?.length && !accountId) setAccountId(list[0]!.id);
  }, [list, accountId]);
  const account = list?.find((a) => a.id === accountId) ?? null;

  const openCompose = (seed: ComposeSeed) => {
    setComposeKey((k) => k + 1);
    setView({ kind: 'compose', seed, key: composeKey + 1 });
  };

  return (
    <div className="page">
      <PageHeader
        title="Email"
        lede="Read, summarise and draft replies. Nothing is sent until you approve the exact text and press Send."
        actions={
          account ? (
            <Button variant="primary" icon="plus" onClick={() => openCompose({ account })} disabled={view.kind === 'compose'}>
              New message
            </Button>
          ) : null
        }
      />

      {accounts.error && !list ? (
        <Callout tone="err" title="Could not load mailboxes">
          <p>{accounts.error.message}</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" icon="refresh" onClick={accounts.reload}>
              Try again
            </Button>
          </div>
        </Callout>
      ) : !list ? (
        <Skeleton h={120} />
      ) : list.length === 0 || !account ? (
        <EmptyState icon="mail" title="No mailbox is connected">
          Connecting a real mailbox is not implemented yet. When a provider is added it will show up here.
        </EmptyState>
      ) : (
        <>
          <AccountBar accounts={list} account={account} onSelect={setAccountId} compact={view.kind === 'compose'} />

          {view.kind === 'compose' ? (
            <ComposePanel
              key={view.key}
              seed={view.seed}
              ai={ai}
              onBack={() => setView({ kind: 'list' })}
              onChanged={drafts.reload}
            />
          ) : (
            <>
              <Tabs
                idPrefix="mail"
                label="Mailbox sections"
                value={tab}
                onChange={setTab}
                items={[
                  { id: 'inbox', label: 'Inbox' },
                  { id: 'drafts', label: 'Drafts', badge: drafts.data?.filter((d) => d.status !== 'sent').length ? <Badge>{drafts.data.filter((d) => d.status !== 'sent').length}</Badge> : null },
                ]}
              />
              <div style={{ height: 'var(--s-4)' }} />
              <div hidden={tab !== 'inbox'} role="tabpanel" id="mail-panel-inbox" aria-labelledby="mail-tab-inbox">
                <Inbox account={account} ai={ai} onReply={(thread) => openCompose({ account, thread })} />
              </div>
              <div hidden={tab !== 'drafts'} role="tabpanel" id="mail-panel-drafts" aria-labelledby="mail-tab-drafts">
                <Drafts
                  state={drafts}
                  accountId={account.id}
                  onOpen={(d) => openCompose({ account, draft: d })}
                  onNew={() => openCompose({ account })}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function AccountBar({ accounts, account, onSelect, compact }: { accounts: EmailAccountDTO[]; account: EmailAccountDTO; onSelect: (id: string) => void; compact?: boolean }) {
  return (
    <div className="stack" style={{ marginBottom: 'var(--s-5)' }}>
      <div className={`account-bar${account.isFixture ? ' account-fixture' : ''}`}>
        <div className="row" style={{ gap: 10 }}>
          {account.isFixture ? (
            <Badge tone="info">
              <Icon name="database" size="sm" /> Local sample mailbox
            </Badge>
          ) : (
            <Badge tone="ok" dot>
              {account.label}
            </Badge>
          )}
          {accounts.length > 1 ? (
            <select className="select" style={{ width: 'auto', minWidth: 200 }} aria-label="Mailbox" value={account.id} onChange={(e) => onSelect(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} ({a.address})
                </option>
              ))}
            </select>
          ) : (
            <span style={{ fontWeight: 600 }}>{account.address}</span>
          )}
          <span className="spacer" />
          {!compact ? (
            <>
              <Badge tone={account.canRead ? 'neutral' : 'warn'}>{account.canRead ? 'Can read' : 'Cannot read'}</Badge>
              <Badge tone={account.canSend ? 'neutral' : 'warn'}>{account.canSend ? 'Can send' : 'Cannot send'}</Badge>
            </>
          ) : null}
        </div>
        {!compact ? (
          <p className="small" style={{ margin: 0 }}>
            {account.statusDetail}
          </p>
        ) : null}
      </div>
      {account.isFixture && !compact ? (
        <Callout tone="info" title="These are sample messages, not your real inbox">
          The messages below are fictional and stored locally. Reading a real mailbox (Gmail, Outlook, IMAP) is <strong>not implemented yet</strong>. Nothing you “send” here is delivered to anyone.
        </Callout>
      ) : null}
    </div>
  );
}

/* ---------- Inbox ---------- */
function Inbox({ account, ai, onReply }: { account: EmailAccountDTO; ai: ReturnType<typeof useAiAvailability>; onReply: (t: EmailThreadDetail) => void }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'' | 'unread' | 'needs_reply'>('');
  const dq = useDebounced(q.trim(), 250);
  const threads = useAsync((s) => api.email.threads({ accountId: account.id, q: dq || undefined, filter: filter || undefined }, s), [account.id, dq, filter]);
  const [selected, setSelected] = useState<string | null>(null);
  const filtering = !!dq || !!filter;

  return (
    <div className={`mail${selected ? ' mail-open' : ''}`}>
      <div className="mail-list card">
        <div className="mail-tools">
          <div className="search-wrap">
            <Icon name="search" />
            <input className="input input-search" type="search" placeholder="Search mail" aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="segmented" role="group" aria-label="Filter threads">
            {(
              [
                ['', 'All'],
                ['unread', 'Unread'],
                ['needs_reply', 'Needs reply'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {threads.error && !threads.data ? (
          <div className="card-body">
            <Callout tone="err" title="Could not load messages">
              {threads.error.message}
            </Callout>
          </div>
        ) : !threads.data ? (
          <div className="card-body">
            <Skeleton h={60} />
          </div>
        ) : threads.data.length === 0 ? (
          <div className="card-body">
            <EmptyState compact title={filtering ? 'No threads match' : 'No messages'}>
              {filtering ? 'Try another search or filter.' : 'This mailbox has no threads.'}
            </EmptyState>
          </div>
        ) : (
          <ul className="thread-list" aria-label="Threads">
            {threads.data.map((t) => (
              <li key={t.id}>
                <button type="button" className={`thread${selected === t.id ? ' thread-on' : ''}${t.unread ? ' thread-unread' : ''}`} onClick={() => setSelected(t.id)} aria-current={selected === t.id ? 'true' : undefined}>
                  <div className="row-nowrap" style={{ gap: 8 }}>
                    {t.unread ? <span className="unread-dot" title="Unread" aria-label="Unread" /> : null}
                    <span className="thread-subject truncate">{t.subject || '(no subject)'}</span>
                    <span className="tiny faint nowrap">{relativeTime(t.lastMessageAt)}</span>
                  </div>
                  <div className="small muted thread-snippet">{t.snippet}</div>
                  <div className="row" style={{ gap: 6 }}>
                    {t.needsReply ? <Badge tone="warn">Needs reply</Badge> : null}
                    {t.hasSummary ? <Badge outline>Summarised</Badge> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mail-detail">
        {selected ? (
          <ThreadView key={selected} id={selected} ai={ai} onBack={() => setSelected(null)} onListChanged={threads.reload} onReply={onReply} />
        ) : (
          <div className="mail-placeholder">
            <EmptyState icon="inbox" title="Select a thread">
              Choose a conversation to read it, summarise it or write a reply.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

function ThreadView({ id, ai, onBack, onListChanged, onReply }: { id: string; ai: ReturnType<typeof useAiAvailability>; onBack: () => void; onListChanged: () => void; onReply: (t: EmailThreadDetail) => void }) {
  const toast = useToast();
  const t = useAsync((s) => api.email.thread(id, s), [id]);
  const [busy, setBusy] = useState<null | 'read' | 'sum'>(null);
  const [sumError, setSumError] = useState<string | null>(null);
  const thread = t.data;

  const toggleRead = async () => {
    if (!thread) return;
    setBusy('read');
    try {
      t.setData(await api.email.markRead(id, thread.unread));
      onListChanged();
    } catch (e) {
      toast.error(e, 'Could not update');
    } finally {
      setBusy(null);
    }
  };
  const summarize = async () => {
    setBusy('sum');
    setSumError(null);
    try {
      t.setData(await api.email.summarize(id));
      onListChanged();
    } catch (e) {
      setSumError((e as Error).message);
      toast.error(e, 'Could not summarise');
    } finally {
      setBusy(null);
    }
  };

  if (t.error && !thread)
    return (
      <div className="card card-pad">
        <Button variant="quiet" icon="arrow-left" className="mail-back" onClick={onBack}>
          Back to list
        </Button>
        <Callout tone="err" title="Could not open this thread">
          {t.error.message}
        </Callout>
      </div>
    );
  if (!thread)
    return (
      <div className="card card-pad" aria-busy="true">
        <Skeleton h={24} w="60%" />
        <div style={{ height: 12 }} />
        <Skeleton h={120} />
      </div>
    );

  const sum = thread.summary;
  return (
    <article className="card mail-thread" aria-label={`Thread: ${thread.subject}`}>
      <div className="card-head">
        <Button variant="quiet" size="sm" icon="arrow-left" className="mail-back" onClick={onBack}>
          Back
        </Button>
        <h2 style={{ flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' }}>{thread.subject || '(no subject)'}</h2>
        {thread.needsReply ? <Badge tone="warn">Needs reply</Badge> : null}
        {thread.unread ? <Badge tone="info" dot>Unread</Badge> : null}
      </div>
      <div className="card-body stack">
        <div className="row">
          <Button size="sm" icon="send" variant="primary" onClick={() => onReply(thread)}>
            Reply
          </Button>
          <Button size="sm" icon={thread.unread ? 'check' : 'eye-off'} busy={busy === 'read'} onClick={() => void toggleRead()}>
            {thread.unread ? 'Mark as read' : 'Mark as unread'}
          </Button>
          <Button size="sm" icon="list" busy={busy === 'sum'} disabled={ai.configured === false} onClick={() => void summarize()} title={ai.configured === false ? ai.reason ?? undefined : undefined}>
            {sum ? 'Summarise again' : 'Summarise with AI'}
          </Button>
        </div>
        {ai.configured === false ? <p className="tiny muted">AI summaries are off: {ai.reason}</p> : null}
        {sumError ? (
          <Callout tone="warn" title="No summary">
            {sumError}
          </Callout>
        ) : null}
        {sum ? (
          <div className="summary">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="eyebrow">AI summary</div>
              <span className="tiny faint">written {relativeTime(sum.at)}. May contain mistakes; check the messages.</span>
            </div>
            <p style={{ margin: '6px 0' }}>{sum.summary}</p>
            {sum.actionItems.length ? (
              <>
                <div className="eyebrow">Action items</div>
                <ul className="bullets">
                  {sum.actionItems.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="small muted">No action items were found.</p>
            )}
          </div>
        ) : null}

        <ol className="messages">
          {thread.messages.map((m) => (
            <li key={m.id} className={`message${m.direction === 'out' ? ' message-out' : ''}`}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{m.direction === 'out' ? 'You' : m.fromName || m.fromAddr}</span>{' '}
                  <span className="small muted">&lt;{m.fromAddr}&gt;</span>
                </div>
                <span className="tiny faint nowrap">{formatDateTime(m.date)}</span>
              </div>
              <div className="tiny muted">To: {m.to.join(', ') || '—'}{m.cc.length ? ` · Cc: ${m.cc.join(', ')}` : ''}</div>
              <pre className="mail-pre">{m.body}</pre>
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

/* ---------- Drafts ---------- */
function Drafts({ state, accountId, onOpen, onNew }: { state: ReturnType<typeof useAsync<import('@shared/api').EmailDraftDTO[]>>; accountId: string; onOpen: (d: import('@shared/api').EmailDraftDTO) => void; onNew: () => void }) {
  const list = state.data?.filter((d) => d.accountId === accountId);
  if (state.error && !state.data)
    return (
      <Callout tone="err" title="Could not load drafts">
        {state.error.message}
      </Callout>
    );
  if (!list) return <Skeleton h={80} />;
  if (list.length === 0)
    return (
      <EmptyState icon="send" title="No drafts" action={<Button variant="primary" icon="plus" onClick={onNew}>New message</Button>}>
        Drafts you save, approve or send from here are listed with their status. You can also start one from a thread with Reply.
      </EmptyState>
    );
  return (
    <ul className="card list" aria-label="Drafts">
      {list.map((d) => (
        <li key={d.id}>
          <button type="button" className="prow draft-row" onClick={() => onOpen(d)}>
            <div className="prow-main">
              <div className="prow-title truncate">{d.subject || '(no subject)'}</div>
              <div className="tiny muted truncate">
                To {d.to.join(', ') || '—'} · {d.threadId ? 'Reply' : 'New message'} · updated {relativeTime(d.updatedAt)}
              </div>
            </div>
            {draftStatusBadge(d)}
            <Icon name="chevron-right" className="faint" />
          </button>
        </li>
      ))}
    </ul>
  );
}
