import { useEffect, useRef, useState } from 'react';
import type { EmailAccountDTO, EmailDraftDTO, EmailThreadDetail, EmailThreadSummary } from '@shared/api';
import { api } from '../../api/client';
import { Badge, Button, Callout, EmptyState, IconButton, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useAiAvailability } from '../../hooks/ai';
import { useAsync, useDebounced, useDocumentTitle, usePolling } from '../../hooks/hooks';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Compose, type ComposeSeed } from './Compose';
import { ConnectFlow } from './ConnectFlow';
import { ThreadView } from './ThreadView';
import { Avatar, draftStatusBadge, mailTime } from './util';

type Box = 'inbox' | 'sent' | 'drafts';
type Filter = '' | 'unread' | 'needs_reply';
type View = { kind: 'list' } | { kind: 'compose'; seed: ComposeSeed; key: number };

const count = (n: number | undefined) => (n == null ? null : n > 99 ? '99+' : n > 0 ? String(n) : null);

export function Email() {
  useDocumentTitle('Email');
  const toast = useToast();
  const ai = useAiAvailability();
  const accounts = useAsync((s) => api.email.accounts(s), []);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [box, setBox] = useState<Box>('inbox');
  const [filter, setFilter] = useState<Filter>('');
  const [q, setQ] = useState('');
  const [serverSearch, setServerSearch] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [composeKey, setComposeKey] = useState(0);
  const [version, setVersion] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const dq = useDebounced(q.trim(), 250);

  const list = accounts.data;
  useEffect(() => {
    if (list?.length && (!accountId || !list.some((a) => a.id === accountId))) setAccountId(list[0]!.id);
  }, [list, accountId]);
  const account = list?.find((a) => a.id === accountId) ?? null;

  // Poll while a sync is running; refresh lists when it finishes.
  const syncing = !!account && (account.syncState === 'syncing');
  usePolling(async () => accounts.setData(await api.email.accounts()), 2500, syncing);
  const prevSync = useRef<string | null>(null);
  useEffect(() => {
    if (!account) return;
    const sig = `${account.syncState}|${account.lastSyncAt}`;
    if (prevSync.current && prevSync.current !== sig) setVersion((v) => v + 1);
    prevSync.current = sig;
  }, [account]);

  const bump = () => setVersion((v) => v + 1);
  useEffect(() => setServerSearch(false), [dq]);
  useEffect(() => setSelected(null), [accountId, box, filter]);

  const threads = useAsync(
    (s) => (account && box !== 'drafts' ? api.email.threads({ accountId: account.id, q: dq || undefined, filter: box === 'inbox' ? filter || undefined : undefined, mailbox: box === 'sent' ? 'sent' : 'inbox', serverSearch: serverSearch && !!dq }, s) : Promise.resolve([] as EmailThreadSummary[])),
    [account?.id, box, filter, dq, serverSearch, version],
  );
  const unread = useAsync((s) => (account ? api.email.threads({ accountId: account.id, filter: 'unread', mailbox: 'inbox' }, s) : Promise.resolve([] as EmailThreadSummary[])), [account?.id, version]);
  const needs = useAsync((s) => (account ? api.email.threads({ accountId: account.id, filter: 'needs_reply', mailbox: 'inbox' }, s) : Promise.resolve([] as EmailThreadSummary[])), [account?.id, version]);
  const drafts = useAsync((s) => api.email.drafts(s), [version]);
  const myDrafts = (drafts.data ?? []).filter((d) => !account || d.accountId === account.id);
  const openDrafts = myDrafts.filter((d) => d.status !== 'sent');

  const openCompose = (seed: ComposeSeed) => {
    setComposeKey((k) => k + 1);
    setView({ kind: 'compose', seed, key: composeKey + 1 });
  };
  const closeCompose = () => setView({ kind: 'list' });

  const syncNow = async () => {
    if (!account || account.isFixture) return;
    try {
      const updated = await api.email.sync(account.id);
      accounts.setData((prev) => prev?.map((a) => (a.id === updated.id ? updated : a)));
    } catch (e) {
      toast.error(e, 'Could not start a sync');
    }
  };

  const disconnect = async () => {
    if (!account) return;
    try {
      await api.email.disconnect(account.id);
      toast.success('Mailbox disconnected', 'Its stored password and local copy were removed. Your mailbox on the server was not touched.');
      setManageOpen(false);
      setAccountId(null);
      accounts.reload();
      bump();
    } catch (e) {
      toast.error(e, 'Could not disconnect');
    }
  };

  const composing = view.kind === 'compose';

  return (
    <div className="page page-mail">
      {accounts.error && !list ? (
        <Callout tone="err" title="Could not load your mailbox">
          <p>{accounts.error.message}</p>
          <div style={{ marginTop: 8 }}><Button size="sm" icon="refresh" onClick={accounts.reload}>Try again</Button></div>
        </Callout>
      ) : !list ? (
        <Skeleton h={300} />
      ) : !account ? (
        <EmptyState icon="mail" title="No mailbox is connected" action={<Button variant="primary" icon="link" onClick={() => setConnectOpen(true)}>Connect mailbox</Button>}>
          Connect your email with an app password to read, summarise and reply to your own mail.
        </EmptyState>
      ) : (
        <>
          <Banner collapse={!!selected || composing} account={account} onConnect={() => setConnectOpen(true)} onRetry={() => void syncNow()} />
          <div className={`mailapp${selected ? ' has-thread' : ''}${composing ? ' composing' : ''}`}>
            <aside className="mrail" aria-label="Mailbox">
              <MailNav layout="rail" account={account} box={box} setBox={(b) => { setBox(b); setFilter(''); }} filter={filter} setFilter={(f) => { setBox('inbox'); setFilter(f); }} unread={unread.data?.length} needs={needs.data?.length} drafts={openDrafts.length} onCompose={() => openCompose({ account })} onManage={() => setManageOpen(true)} onSync={() => void syncNow()} />
            </aside>
            <div className="mnarrow">
              <MailNav layout="bar" account={account} box={box} setBox={(b) => { setBox(b); setFilter(''); }} filter={filter} setFilter={(f) => { setBox('inbox'); setFilter(f); }} unread={unread.data?.length} needs={needs.data?.length} drafts={openDrafts.length} onCompose={() => openCompose({ account })} onManage={() => setManageOpen(true)} onSync={() => void syncNow()} />
            </div>

            <section className="mlist" aria-label={box === 'drafts' ? 'Drafts' : 'Conversations'}>
              <div className="mlist-search">
                <Icon name="search" />
                <input type="search" className="plain-input" placeholder={box === 'sent' ? 'Search sent mail' : 'Search mail'} aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} disabled={box === 'drafts'} />
                {q ? <IconButton icon="x" size="sm" label="Clear search" onClick={() => setQ('')} /> : null}
              </div>
              <div className="mlist-scroll">
                {box === 'drafts' ? (
                  <DraftList state={drafts} items={myDrafts} onOpen={(d) => openCompose({ account, draft: d })} onNew={() => openCompose({ account })} />
                ) : (
                  <ThreadList state={threads} account={account} q={dq} filter={filter} box={box} selected={selected} onSelect={setSelected} serverSearch={serverSearch} onServerSearch={() => setServerSearch(true)} onClear={() => { setQ(''); setFilter(''); }} onRetry={() => void syncNow()} />
                )}
              </div>
            </section>

            <section className="mread" aria-label="Reading pane">
              {composing ? (
                <Compose key={view.key} seed={view.seed} ai={ai} onBack={closeCompose} onChanged={bump} />
              ) : selected ? (
                <ThreadView key={selected} id={selected} ai={ai} onBack={() => setSelected(null)} onListChanged={bump} onReply={(t: EmailThreadDetail, startAi) => openCompose({ account, thread: t, startAi })} />
              ) : (
                <div className="mread-empty">
                  <EmptyState icon="inbox" title="Select a conversation" center>
                    Choose a message on the left to read it, summarise it, or write a reply.
                  </EmptyState>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      <ConnectFlow
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={(a) => {
          setConnectOpen(false);
          setAccountId(a.id);
          accounts.reload();
          bump();
        }}
      />
      <ManageModal account={account} open={manageOpen} onClose={() => setManageOpen(false)} onSync={() => { setManageOpen(false); void syncNow(); }} onDisconnect={() => void disconnect()} onConnect={() => { setManageOpen(false); setConnectOpen(true); }} />
    </div>
  );
}

/* ---------- honest connection banner ---------- */
function Banner({ account, onConnect, onRetry, collapse }: { account: EmailAccountDTO; onConnect: () => void; onRetry: () => void; collapse?: boolean }) {
  const cls = collapse ? ' mbanner-collapse' : '';
  if (account.isFixture)
    return (
      <div className={`mbanner mbanner-info${cls}`} role="note">
        <Icon name="database" />
        <div className="mbanner-text">
          <strong>Sample mailbox</strong> — fictional messages. Connect your real mailbox to see your own email.
        </div>
        <Button variant="primary" size="sm" icon="link" onClick={onConnect}>Connect mailbox</Button>
      </div>
    );
  if (account.syncState === 'syncing' || account.syncState === 'never')
    return (
      <div className={`mbanner mbanner-info${cls}`} role="status">
        <span className="spinner" aria-hidden="true" />
        <div className="mbanner-text">Syncing your mail from {account.address}… This can take a minute the first time. You can keep using the app.</div>
      </div>
    );
  if (account.syncState === 'error')
    return (
      <div className={`mbanner mbanner-err${cls}`} role="alert">
        <Icon name="alert" />
        <div className="mbanner-text"><strong>Sync problem.</strong> {account.lastError ?? 'The last sync failed.'}</div>
        <Button size="sm" icon="refresh" onClick={onRetry}>Retry</Button>
      </div>
    );
  return null;
}

/* ---------- rail / toolbar ---------- */
function MailNav(props: {
  layout: 'rail' | 'bar';
  account: EmailAccountDTO;
  box: Box;
  setBox: (b: Box) => void;
  filter: Filter;
  setFilter: (f: Filter) => void;
  unread?: number;
  needs?: number;
  drafts: number;
  onCompose: () => void;
  onManage: () => void;
  onSync: () => void;
}) {
  const { account, box, filter } = props;
  const items: { id: Box; label: string; icon: 'inbox' | 'send' | 'edit'; n: string | null }[] = [
    { id: 'inbox', label: 'Inbox', icon: 'inbox', n: count(props.unread) },
    { id: 'sent', label: 'Sent', icon: 'send', n: null },
    { id: 'drafts', label: 'Drafts', icon: 'edit', n: count(props.drafts) },
  ];
  const state = account.isFixture ? { label: 'Sample mailbox', tone: 'info' as const } : account.syncState === 'error' ? { label: 'Sync problem', tone: 'err' as const } : account.syncState === 'ok' ? { label: 'Connected', tone: 'ok' as const } : { label: 'Syncing…', tone: 'accent' as const };

  const chip = (
    <button type="button" className="acct" onClick={props.onManage} aria-label={`Mailbox ${account.address}. ${state.label}. Open mailbox settings`}>
      <span className={`acct-dot acct-${state.tone}`} aria-hidden="true" />
      <span className="acct-main">
        <span className="acct-addr truncate">{account.address}</span>
        <span className="tiny muted">{state.label}{!account.isFixture && account.lastSyncAt ? ` · ${relativeTime(account.lastSyncAt)}` : ''}</span>
      </span>
      <Icon name="more" size="sm" className="faint" />
    </button>
  );

  if (props.layout === 'bar')
    return (
      <div className="mbar">
        <div className="mbar-row">
          <Button variant="primary" size="sm" icon="edit" onClick={props.onCompose}>Compose</Button>
          <div className="segmented" role="group" aria-label="Mailbox">
            {items.map((i) => (
              <button key={i.id} type="button" aria-pressed={box === i.id && !filter} onClick={() => props.setBox(i.id)}>
                {i.label}{i.n ? ` ${i.n}` : ''}
              </button>
            ))}
          </div>
        </div>
        <div className="mbar-row">
          <button type="button" className={`pill pill-sm${filter === 'unread' ? ' pill-on' : ''}`} aria-pressed={filter === 'unread'} onClick={() => props.setFilter(filter === 'unread' ? '' : 'unread')}>Unread{count(props.unread) ? ` ${count(props.unread)}` : ''}</button>
          <button type="button" className={`pill pill-sm${filter === 'needs_reply' ? ' pill-on' : ''}`} aria-pressed={filter === 'needs_reply'} onClick={() => props.setFilter(filter === 'needs_reply' ? '' : 'needs_reply')}>Needs reply{count(props.needs) ? ` ${count(props.needs)}` : ''}</button>
          <span className="spacer" />
          {chip}
        </div>
      </div>
    );

  return (
    <div className="mrail-in">
      <Button variant="primary" icon="edit" block onClick={props.onCompose}>Compose</Button>
      <nav aria-label="Mailboxes" className="mnav">
        {items.map((i) => (
          <button key={i.id} type="button" className={`mnav-item${box === i.id && !filter ? ' mnav-on' : ''}`} aria-current={box === i.id && !filter ? 'page' : undefined} onClick={() => props.setBox(i.id)}>
            <Icon name={i.icon} />
            <span>{i.label}</span>
            {i.n ? <span className="mnav-n">{i.n}</span> : null}
          </button>
        ))}
      </nav>
      <div className="mfilters" role="group" aria-label="Filters">
        <div className="eyebrow">Filters</div>
        <button type="button" className={`mnav-item${filter === 'unread' ? ' mnav-on' : ''}`} aria-pressed={filter === 'unread'} onClick={() => props.setFilter(filter === 'unread' ? '' : 'unread')}>
          <Icon name="eye" /><span>Unread</span>{count(props.unread) ? <span className="mnav-n">{count(props.unread)}</span> : null}
        </button>
        <button type="button" className={`mnav-item${filter === 'needs_reply' ? ' mnav-on' : ''}`} aria-pressed={filter === 'needs_reply'} onClick={() => props.setFilter(filter === 'needs_reply' ? '' : 'needs_reply')}>
          <Icon name="reply" /><span>Needs reply</span>{count(props.needs) ? <span className="mnav-n">{count(props.needs)}</span> : null}
        </button>
      </div>
      <div className="spacer" />
      {!account.isFixture ? (
        <Button size="sm" variant="quiet" icon="refresh" disabled={account.syncState === 'syncing'} onClick={props.onSync}>Sync now</Button>
      ) : null}
      {chip}
    </div>
  );
}

/* ---------- lists ---------- */
function ThreadList({ state, account, q, filter, box, selected, onSelect, serverSearch, onServerSearch, onClear, onRetry }: {
  state: ReturnType<typeof useAsync<EmailThreadSummary[]>>;
  account: EmailAccountDTO;
  q: string;
  filter: Filter;
  box: Box;
  selected: string | null;
  onSelect: (id: string) => void;
  serverSearch: boolean;
  onServerSearch: () => void;
  onClear: () => void;
  onRetry: () => void;
}) {
  const data = state.data;
  if (state.error && !data)
    return (
      <div className="mlist-pad">
        <Callout tone="err" title="Could not load messages">
          {state.error.message}
          <div style={{ marginTop: 8 }}><Button size="sm" icon="refresh" onClick={state.reload}>Try again</Button></div>
        </Callout>
      </div>
    );
  if (!data)
    return (
      <ul className="trow-skel" aria-busy="true" aria-label="Loading messages">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i}><Skeleton h={40} w={40} style={{ borderRadius: '50%' }} /><div style={{ flex: 1 }}><Skeleton w="55%" /><div style={{ height: 8 }} /><Skeleton w="85%" /></div></li>
        ))}
      </ul>
    );
  if (data.length === 0) {
    const real = !account.isFixture;
    if (q)
      return (
        <div className="mlist-pad">
          <EmptyState compact icon="search" title={`No results for “${q}”`} action={real && !serverSearch ? <Button size="sm" onClick={onServerSearch}>Search the whole mailbox on the server</Button> : <Button size="sm" onClick={onClear}>Clear search</Button>}>
            {serverSearch ? 'Nothing matched on the mail server either.' : 'Searching mail already downloaded to this computer.'}
          </EmptyState>
        </div>
      );
    if (real && (account.syncState === 'syncing' || account.syncState === 'never'))
      return (
        <div className="mlist-pad">
          <EmptyState compact icon="refresh" title="Syncing your mail…">Your messages will appear here as soon as they arrive. This can take a minute the first time.</EmptyState>
        </div>
      );
    if (real && account.syncState === 'error')
      return (
        <div className="mlist-pad">
          <EmptyState compact icon="alert" title="Mail could not be synced" action={<Button size="sm" icon="refresh" onClick={onRetry}>Retry sync</Button>}>
            {account.lastError ?? 'The last sync failed.'}
          </EmptyState>
        </div>
      );
    return (
      <div className="mlist-pad">
        <EmptyState compact icon={filter ? 'search' : 'inbox'} title={filter === 'unread' ? 'Nothing unread' : filter === 'needs_reply' ? 'Nothing needs a reply' : box === 'sent' ? 'No sent mail yet' : 'Your inbox is empty'} action={filter ? <Button size="sm" onClick={onClear}>Show all</Button> : undefined}>
          {filter ? 'Clear the filter to see everything.' : box === 'sent' ? 'Messages you send from here will be listed here.' : 'New mail will show up here.'}
        </EmptyState>
      </div>
    );
  }
  return (
    <>
      <ul className="tlist" aria-label="Conversations">
        {data.map((t) => (
          <li key={t.id}>
            <button type="button" className={`trow${selected === t.id ? ' trow-on' : ''}${t.unread ? ' trow-unread' : ''}`} onClick={() => onSelect(t.id)} aria-current={selected === t.id ? 'true' : undefined}>
              <Avatar name={t.from || t.subject || '?'} />
              <span className="trow-main">
                <span className="trow-line">
                  <span className="trow-from truncate">{t.from || (account.isFixture ? 'Sample sender' : 'Unknown sender')}</span>
                  {t.messageCount > 1 ? <span className="tiny faint">{t.messageCount}</span> : null}
                  <span className="spacer" />
                  {t.hasAttachments ? <Icon name="paperclip" size="sm" className="faint" /> : null}
                  <span className="tiny faint nowrap">{mailTime(t.lastMessageAt)}</span>
                </span>
                <span className="trow-subject truncate">{t.unread ? <span className="unread-dot" aria-label="Unread" /> : null}{t.subject || '(no subject)'}</span>
                <span className="trow-snippet">{t.snippet}</span>
                {t.needsReply ? <span className="trow-tag">Needs reply</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {q && !account.isFixture && !serverSearch ? (
        <div className="mlist-pad"><Button size="sm" variant="quiet" onClick={onServerSearch}>Search the whole mailbox on the server</Button></div>
      ) : null}
    </>
  );
}

function DraftList({ state, items, onOpen, onNew }: { state: ReturnType<typeof useAsync<EmailDraftDTO[]>>; items: EmailDraftDTO[]; onOpen: (d: EmailDraftDTO) => void; onNew: () => void }) {
  if (state.error && !state.data) return <div className="mlist-pad"><Callout tone="err" title="Could not load drafts">{state.error.message}</Callout></div>;
  if (!state.data) return <div className="mlist-pad"><Skeleton h={60} /></div>;
  if (items.length === 0)
    return (
      <div className="mlist-pad">
        <EmptyState compact icon="edit" title="No drafts" action={<Button size="sm" variant="primary" icon="edit" onClick={onNew}>Compose</Button>}>
          Drafts you save, approve or send from here are listed with their status.
        </EmptyState>
      </div>
    );
  return (
    <ul className="tlist" aria-label="Drafts">
      {items.map((d) => (
        <li key={d.id}>
          <button type="button" className="trow" onClick={() => onOpen(d)}>
            <Avatar name={d.to[0] ?? 'Draft'} />
            <span className="trow-main">
              <span className="trow-line">
                <span className="trow-from truncate">{d.to.join(', ') || '(no recipient)'}</span>
                <span className="spacer" />
                <span className="tiny faint nowrap">{mailTime(d.updatedAt)}</span>
              </span>
              <span className="trow-subject truncate">{d.subject || '(no subject)'}</span>
              <span className="trow-snippet">{d.body}</span>
              <span>{draftStatusBadge(d)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ---------- mailbox settings ---------- */
function ManageModal({ account, open, onClose, onSync, onDisconnect, onConnect }: { account: EmailAccountDTO | null; open: boolean; onClose: () => void; onSync: () => void; onDisconnect: () => void; onConnect: () => void }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setConfirm(false), [open]);
  if (!account) return null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Mailbox"
      footer={
        account.isFixture ? (
          <>
            <Button variant="quiet" onClick={onClose}>Close</Button>
            <Button variant="primary" icon="link" onClick={onConnect}>Connect mailbox</Button>
          </>
        ) : confirm ? (
          <>
            <Button variant="quiet" onClick={() => setConfirm(false)}>Keep it connected</Button>
            <Button variant="danger" onClick={onDisconnect}>Disconnect</Button>
          </>
        ) : (
          <>
            <Button variant="quiet" onClick={() => setConfirm(true)}>Disconnect</Button>
            <Button icon="refresh" disabled={account.syncState === 'syncing'} onClick={onSync}>Sync now</Button>
          </>
        )
      }
    >
      <div className="stack">
        <dl className="kv">
          <dt>Address</dt><dd>{account.address}</dd>
          <dt>Status</dt><dd>{account.statusDetail}</dd>
          {!account.isFixture ? (<><dt>Server</dt><dd>{account.imapHost ?? '—'}</dd><dt>Last sync</dt><dd>{account.lastSyncAt ? formatDateTime(account.lastSyncAt) : 'Not yet'}</dd></>) : null}
          <dt>Can read</dt><dd>{account.canRead ? 'Yes' : 'No'}</dd>
          <dt>Can send</dt><dd>{account.canSend ? 'Yes' : 'No'}</dd>
        </dl>
        {account.lastError ? <Callout tone="err" title="Last sync error">{account.lastError}</Callout> : null}
        {confirm ? <Callout tone="warn" title="Disconnect this mailbox?">This removes the stored password and the copy of your mail kept on this computer. Your mailbox on the mail server is not touched.</Callout> : null}
        {account.isFixture ? <Badge tone="info">Fictional sample messages</Badge> : null}
      </div>
    </Modal>
  );
}
