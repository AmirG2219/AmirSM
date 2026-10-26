import { useEffect, useRef, useState } from 'react';
import type { EmailAttachmentDTO, EmailMessageDTO, EmailThreadDetail } from '@shared/api';
import { api } from '../../api/client';
import { Badge, Button, Callout, IconButton, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import type { AiAvailability } from '../../hooks/ai';
import { useAsync } from '../../hooks/hooks';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Avatar, fileSize, splitQuoted } from './util';

function AttachmentChip({ a }: { a: EmailAttachmentDTO }) {
  return (
    <a
      className={`attach${a.risky ? ' attach-risky' : ''}`}
      href={a.downloadUrl}
      download={a.filename}
      onClick={(e) => {
        if (a.risky && !window.confirm(`“${a.filename}” is a type of file that can run code on your computer. Only download it if you trust the sender. Download anyway?`)) e.preventDefault();
      }}
      title={a.risky ? 'Executable or script file: only open it if you trust the sender' : `Download ${a.filename}`}
    >
      <Icon name={a.risky ? 'alert' : 'paperclip'} size="sm" />
      <span className="truncate">{a.filename}</span>
      <span className="tiny faint nowrap">{fileSize(a.size)}</span>
      <Icon name="download" size="sm" />
    </a>
  );
}

function MessageCard({ m, defaultOpen }: { m: EmailMessageDTO; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [showQuoted, setShowQuoted] = useState(false);
  const name = m.direction === 'out' ? 'You' : m.fromName || m.fromAddr;
  const { main, quoted } = splitQuoted(m.body);
  const files = m.attachments.filter((a) => !a.inline);
  return (
    <li className={`mcard${m.direction === 'out' ? ' mcard-out' : ''}`}>
      <button type="button" className="mcard-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Avatar name={name} />
        <span className="mcard-who">
          <span className="mcard-name">{name}{m.unread ? <span className="unread-dot" aria-label="Unread" /> : null}</span>
          <span className="tiny muted truncate">{open ? `${m.fromAddr} · to ${m.to.join(', ') || '—'}${m.cc.length ? ` · cc ${m.cc.join(', ')}` : ''}` : main.replace(/\s+/g, ' ').slice(0, 110)}</span>
        </span>
        <span className="tiny faint nowrap">{formatDateTime(m.date)}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size="sm" className="faint" />
      </button>
      {open ? (
        <div className="mcard-body">
          <pre className="mail-pre">{main}</pre>
          {quoted ? (
            <>
              <button type="button" className="quote-toggle" onClick={() => setShowQuoted((s) => !s)} aria-expanded={showQuoted} aria-label={showQuoted ? 'Hide quoted text' : 'Show quoted text'}>
                <Icon name="more" size="sm" />
              </button>
              {showQuoted ? <pre className="mail-pre quoted">{quoted}</pre> : null}
            </>
          ) : null}
          {m.truncated ? <p className="tiny muted">This message was longer than the size limit, so the end is cut off.</p> : null}
          {m.bodySource === 'html_converted' ? <p className="tiny faint">Converted from HTML to plain text. Images and remote content are never loaded.</p> : null}
          {m.bodySource === 'none' && !m.body.trim() ? <p className="small muted">This message has no text content.</p> : null}
          {files.length ? (
            <ul className="attach-list" aria-label="Attachments">
              {files.map((a) => (
                <li key={a.id}>
                  <AttachmentChip a={a} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function ThreadView({
  id, ai, onBack, onListChanged, onReply,
}: {
  id: string;
  ai: AiAvailability;
  onBack: () => void;
  onListChanged: () => void;
  onReply: (t: EmailThreadDetail, startAi: boolean) => void;
}) {
  const toast = useToast();
  const t = useAsync((s) => api.email.thread(id, s), [id]);
  const [busy, setBusy] = useState<null | 'read' | 'sum'>(null);
  const [sumError, setSumError] = useState<string | null>(null);
  const thread = t.data;

  // Opening a thread marks it read (locally and on the mailbox server), like any mail client.
  const autoRead = useRef<string | null>(null);
  useEffect(() => {
    if (!thread || !thread.unread || autoRead.current === thread.id) return;
    autoRead.current = thread.id;
    api.email.markRead(thread.id, true).then((d) => { t.setData(d); onListChanged(); }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.unread]);

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
      <div className="mread-in">
        <div className="mread-top">
          <IconButton icon="arrow-left" label="Back to list" className="mread-back" onClick={onBack} />
        </div>
        <div className="mread-pad">
          <Callout tone="err" title="Could not open this conversation">{t.error.message}</Callout>
          <div style={{ marginTop: 12 }}><Button size="sm" icon="refresh" onClick={t.reload}>Try again</Button></div>
        </div>
      </div>
    );
  if (!thread)
    return (
      <div className="mread-in" aria-busy="true">
        <div className="mread-pad"><Skeleton h={28} w="60%" /><div style={{ height: 16 }} /><Skeleton h={140} /></div>
      </div>
    );

  const sum = thread.summary;
  const aiOff = ai.configured === false;
  const n = thread.messages.length;

  return (
    <article className="mread-in" aria-label={`Conversation: ${thread.subject}`}>
      <div className="mread-top">
        <IconButton icon="arrow-left" label="Back to list" className="mread-back" onClick={onBack} />
        <div className="actionbar2" role="toolbar" aria-label="Message actions">
          <Button size="sm" variant="primary" icon="reply" onClick={() => onReply(thread, false)}>Reply</Button>
          <Button size="sm" icon="edit" disabled={aiOff} onClick={() => onReply(thread, true)} title={aiOff ? ai.reason ?? 'AI is not available.' : 'Reply with a draft written by AI'}>Draft reply with AI</Button>
          <Button size="sm" variant="quiet" icon="list" busy={busy === 'sum'} disabled={aiOff} onClick={() => void summarize()} title={aiOff ? ai.reason ?? undefined : undefined}>{sum ? 'Summarize again' : 'Summarize'}</Button>
          <Button size="sm" variant="quiet" icon={thread.unread ? 'eye' : 'eye-off'} busy={busy === 'read'} onClick={() => void toggleRead()}>{thread.unread ? 'Mark as read' : 'Mark as unread'}</Button>
        </div>
      </div>
      <div className="mread-pad stack">
        <header>
          <h2 className="mread-subject">{thread.subject || '(no subject)'}</h2>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            {thread.needsReply ? <Badge tone="warn">Needs reply</Badge> : null}
            {thread.unread ? <Badge tone="info" dot>Unread</Badge> : null}
            <span className="tiny muted">{n} {n === 1 ? 'message' : 'messages'} · last {relativeTime(thread.lastMessageAt)}</span>
          </div>
        </header>

        {aiOff ? <p className="tiny muted">AI summaries and drafts are off: {ai.reason}</p> : null}
        {thread.serverSyncError ? (
          <Callout tone="warn" title="Read status not saved on your mail server yet">{thread.serverSyncError}</Callout>
        ) : null}
        {sumError ? <Callout tone="warn" title="No summary">{sumError}</Callout> : null}
        {sum ? (
          <section className="summary" aria-label="AI summary">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="eyebrow">AI summary</div>
              <span className="tiny faint">written {relativeTime(sum.at)}. May contain mistakes.</span>
            </div>
            <p style={{ margin: '6px 0' }}>{sum.summary}</p>
            {sum.actionItems.length ? (
              <>
                <div className="eyebrow">Action items</div>
                <ul className="bullets">{sum.actionItems.map((a, i) => <li key={i}>{a}</li>)}</ul>
              </>
            ) : <p className="small muted">No action items were found.</p>}
          </section>
        ) : null}

        <ol className="mcards">
          {thread.messages.map((m, i) => (
            <MessageCard key={m.id} m={m} defaultOpen={i >= n - 2 || m.unread} />
          ))}
        </ol>
      </div>
    </article>
  );
}
