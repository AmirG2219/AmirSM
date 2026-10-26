import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { EmailAccountDTO, EmailDraftDTO, EmailThreadDetail } from '@shared/api';
import { api } from '../../api/client';
import { Badge, Button, Callout, IconButton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import type { AiAvailability } from '../../hooks/ai';
import { formatDateTime } from '../../lib/format';
import { draftStatusBadge, parseAddress } from './util';

export interface ComposeSeed {
  account: EmailAccountDTO;
  thread?: EmailThreadDetail;
  draft?: EmailDraftDTO;
  /** open the "Draft with AI" row immediately */
  startAi?: boolean;
}

function initialFields(seed: ComposeSeed) {
  if (seed.draft) {
    const d = seed.draft;
    return { to: d.to, cc: d.cc, subject: d.subject, body: d.body, ai: d.aiAssisted };
  }
  if (seed.thread) {
    const t = seed.thread;
    const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in') ?? t.messages[t.messages.length - 1];
    return { to: lastIn?.fromAddr ? [lastIn.fromAddr] : [], cc: [] as string[], subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`, body: '', ai: false };
  }
  return { to: [] as string[], cc: [] as string[], subject: '', body: '', ai: false };
}

/* ---------- recipient chips ---------- */
function ChipInput({ id, label, chips, onChange, disabled, autoFocus }: { id: string; label: string; chips: string[]; onChange: (c: string[]) => void; disabled?: boolean; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...chips];
    for (const p of parts) {
      const clean = parseAddress(p) ?? p;
      if (!next.includes(clean)) next.push(clean);
    }
    onChange(next);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' ', 'Tab'].includes(e.key) && text.trim()) {
      e.preventDefault();
      commit(text);
    } else if (e.key === 'Backspace' && !text && chips.length) {
      onChange(chips.slice(0, -1));
    }
  };
  return (
    <div className="chiprow">
      <label htmlFor={id} className="chiprow-label">{label}</label>
      <div className={`chipbox${disabled ? ' chipbox-off' : ''}`} onClick={() => document.getElementById(id)?.focus()}>
        {chips.map((c) => {
          const ok = !!parseAddress(c);
          return (
            <span key={c} className={`rchip${ok ? '' : ' rchip-bad'}`} title={ok ? c : 'This is not a valid email address'}>
              {!ok ? <Icon name="alert" size="sm" /> : null}
              <span className="truncate">{c}</span>
              {!disabled ? (
                <button type="button" aria-label={`Remove ${c}`} onClick={(e) => { e.stopPropagation(); onChange(chips.filter((x) => x !== c)); }}>
                  <Icon name="x" size="sm" />
                </button>
              ) : null}
            </span>
          );
        })}
        {!disabled ? (
          <input id={id} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} onBlur={() => commit(text)} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (/[,;\s]/.test(t.trim())) { e.preventDefault(); commit(t); } }} placeholder={chips.length ? '' : 'name@example.com'} autoFocus={autoFocus} autoComplete="off" inputMode="email" aria-label={label} />
        ) : null}
      </div>
    </div>
  );
}

const TONE_OPTIONS = ['Friendlier', 'More formal', 'Shorter', 'More direct'];

export function Compose({ seed, ai, onBack, onChanged }: { seed: ComposeSeed; ai: AiAvailability; onBack: () => void; onChanged: () => void }) {
  const toast = useToast();
  const init = useMemo(() => initialFields(seed), [seed]);
  const [saved, setSaved] = useState<EmailDraftDTO | null>(seed.draft ?? null);
  const [to, setTo] = useState<string[]>(init.to);
  const [cc, setCc] = useState<string[]>(init.cc);
  const [showCc, setShowCc] = useState(init.cc.length > 0);
  const [subject, setSubject] = useState(init.subject);
  const [body, setBody] = useState(init.body);
  const [aiAssisted, setAiAssisted] = useState(init.ai);
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'send' | 'draft' | 'tone'>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(!!seed.startAi);
  const [instruction, setInstruction] = useState('');
  const [aiNote, setAiNote] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const aiInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (aiOpen) aiInput.current?.focus();
  }, [aiOpen]);

  const sent = saved?.status === 'sent';
  const account = seed.account;
  const fixture = account.isFixture;
  const threadId = seed.thread?.id ?? seed.draft?.threadId ?? null;
  const aiBlocked = ai.configured === false;
  const locked = sent;

  const toValid = to.filter((a) => parseAddress(a));
  const badChips = [...to, ...cc].filter((a) => !parseAddress(a));
  const norm = (list: string[]) => list.map((a) => parseAddress(a) ?? a);
  const dirty = !saved
    ? !!(to.length || cc.length || subject.trim() || body.trim())
    : JSON.stringify([norm(to), norm(cc), subject, body]) !== JSON.stringify([saved.to, saved.cc, saved.subject, saved.body]);
  const approvedButEdited = saved?.status === 'approved' && dirty;
  const canApprove = toValid.length > 0 && badChips.length === 0 && subject.trim() !== '' && body.trim() !== '';

  const save = async (): Promise<EmailDraftDTO | null> => {
    if (badChips.length) {
      setError(`Fix or remove the invalid address: ${badChips[0]}`);
      return null;
    }
    setBusy('save');
    setError(null);
    try {
      const payload = { to: norm(to), cc: norm(cc), subject, body, aiAssisted };
      const d = saved ? await api.email.updateDraft(saved.id, payload) : await api.email.createDraft({ accountId: account.id, threadId, ...payload });
      setSaved(d);
      onChanged();
      return d;
    } catch (e) {
      setError((e as Error).message);
      toast.error(e, 'Could not save the draft');
      return null;
    } finally {
      setBusy(null);
    }
  };

  const startReview = async () => {
    if (dirty || !saved) {
      if (!(await save())) return;
    }
    setReviewing(true);
  };

  const approve = async () => {
    if (!saved) return;
    setBusy('approve');
    setError(null);
    try {
      setSaved(await api.email.approve(saved.id));
      setReviewing(false);
      toast.success('Approved for sending', 'Nothing has been sent yet.');
      onChanged();
    } catch (e) {
      setError((e as Error).message);
      toast.error(e, 'Could not approve');
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!saved) return;
    setBusy('send');
    setError(null);
    try {
      const d = await api.email.send(saved.id);
      setSaved(d);
      onChanged();
      if (d.sendResult?.delivered) toast.success('Sent');
      else toast.push({ tone: 'warn', title: 'Recorded locally, not delivered', message: d.sendResult?.note });
    } catch (e) {
      setError((e as Error).message);
      toast.error(e, 'Could not send');
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  const aiDraft = async () => {
    setBusy('draft');
    setAiNote(null);
    try {
      const r = await api.email.aiDraft({ instruction: instruction.trim(), threadId: threadId ?? undefined });
      setSubject(r.subject || subject);
      setBody(r.body);
      setAiAssisted(true);
      setAiOpen(false);
      setAiNote('The AI wrote this draft. Nothing is saved or sent yet. Read it carefully and change anything you like.');
    } catch (e) {
      toast.error(e, 'AI drafting failed');
    } finally {
      setBusy(null);
    }
  };

  const rewrite = async (tone: string, label: string) => {
    const ta = bodyRef.current;
    const s = ta?.selectionStart ?? 0;
    const e = ta?.selectionEnd ?? 0;
    const hasSel = e > s;
    const text = hasSel ? body.slice(s, e) : body;
    if (!text.trim()) return;
    setBusy('tone');
    try {
      const r = await api.email.aiTone({ text, tone });
      setBody(hasSel ? body.slice(0, s) + r.text + body.slice(e) : r.text);
      setAiAssisted(true);
      setAiNote(`${label}: rewrote ${hasSel ? 'the selected text' : 'the whole message'}. Review the result.`);
    } catch (err) {
      toast.error(err, 'Rewrite failed');
    } finally {
      setBusy(null);
    }
  };

  const result = saved?.sendResult;
  const title = seed.thread ? 'Reply' : seed.draft ? 'Draft' : 'New message';

  return (
    <section className="compose" aria-label={title}>
      <header className="compose-head">
        <IconButton icon="arrow-left" label="Back" onClick={onBack} className="compose-back" />
        <h2>{title}</h2>
        {approvedButEdited ? <Badge tone="warn" dot>Edited: approval no longer valid</Badge> : saved ? draftStatusBadge(saved) : <Badge>Not saved yet</Badge>}
        {aiAssisted ? <Badge tone="accent">AI-assisted</Badge> : null}
        <span className="spacer" />
        <span className="tiny faint compose-from">From {account.address}</span>
      </header>

      <div className="compose-body">
        {sent ? (
          <Callout tone={result?.delivered ? 'ok' : 'warn'} title={result?.delivered ? 'Delivered' : 'Recorded locally — NOT delivered'}>
            <p style={{ margin: 0 }}>{result?.note ?? (result?.delivered ? 'The mail server accepted the message.' : 'The message was not delivered.')}</p>
            <p className="tiny muted" style={{ marginTop: 4 }}>{formatDateTime(saved?.sentAt)}</p>
          </Callout>
        ) : null}
        {saved?.status === 'failed' && result ? <Callout tone="err" title="Sending failed">{result.note}</Callout> : null}

        <div className="fields">
          <ChipInput id="cmp-to" label="To" chips={to} onChange={setTo} disabled={locked} autoFocus={!seed.thread && !seed.draft} />
          {showCc || cc.length ? (
            <ChipInput id="cmp-cc" label="Cc" chips={cc} onChange={setCc} disabled={locked} />
          ) : !locked ? (
            <button type="button" className="linkbtn cc-toggle" onClick={() => setShowCc(true)}>Add Cc</button>
          ) : null}
          <div className="chiprow">
            <label htmlFor="cmp-subject" className="chiprow-label">Subject</label>
            <input id="cmp-subject" className="plain-input" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={locked} maxLength={300} autoComplete="off" />
          </div>
        </div>

        {!locked ? (
          <div className="aibar" role="group" aria-label="Writing help">
            <Button size="sm" icon="edit" disabled={aiBlocked || busy !== null} onClick={() => setAiOpen((o) => !o)} aria-expanded={aiOpen} title={aiBlocked ? ai.reason ?? 'AI is not available.' : undefined}>
              Draft with AI
            </Button>
            <Button size="sm" variant="quiet" icon="refresh" busy={busy === 'tone'} disabled={aiBlocked || !body.trim() || busy !== null} onClick={() => void rewrite('improved wording, same meaning', 'Improved wording')} title="Rewrites the selected text, or the whole message if nothing is selected">
              Improve wording
            </Button>
            <label className="tonesel">
              <span className="sr-only">Change tone</span>
              <select className="select select-sm" value="" disabled={aiBlocked || !body.trim() || busy !== null} onChange={(e) => { const v = e.target.value; if (v) void rewrite(v.toLowerCase(), `Tone: ${v}`); }} aria-label="Change tone">
                <option value="">Change tone…</option>
                {TONE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            {aiBlocked ? <span className="tiny muted aibar-off">AI writing help is off: {ai.reason ?? 'no Anthropic API key is configured.'}</span> : null}
          </div>
        ) : null}
        {aiOpen && !locked && !aiBlocked ? (
          <form className="airow" onSubmit={(e) => { e.preventDefault(); if (instruction.trim().length >= 3) void aiDraft(); }}>
            <input ref={aiInput} className="input" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should the message say? e.g. Thank her, say yes to Saturday, ask about parking." maxLength={2000} aria-label="What should the message say?" />
            <Button type="submit" variant="primary" busy={busy === 'draft'} disabled={instruction.trim().length < 3 || busy !== null}>Write it</Button>
          </form>
        ) : null}
        {aiNote ? <Callout tone="info">{aiNote}</Callout> : null}

        <textarea ref={bodyRef} className="compose-text" value={body} onChange={(e) => setBody(e.target.value)} disabled={locked} placeholder="Write your message…" aria-label="Message body" rows={12} />
        {error ? <Callout tone="err">{error}</Callout> : null}

        {reviewing && saved && saved.status !== 'approved' && !locked ? (
          <div className="review-box" role="region" aria-label="Exactly what will be sent">
            <div className="eyebrow">Exactly what will be sent</div>
            <dl className="kv">
              <dt>From</dt><dd>{account.address}</dd>
              <dt>To</dt><dd>{saved.to.join(', ')}</dd>
              {saved.cc.length ? (<><dt>Cc</dt><dd>{saved.cc.join(', ')}</dd></>) : null}
              <dt>Subject</dt><dd>{saved.subject}</dd>
            </dl>
            <pre className="mail-pre">{saved.body}</pre>
            {fixture ? <p className="small muted">The sample mailbox will not deliver this. Sending only records it locally.</p> : null}
            <div className="row">
              <Button variant="primary" icon="check" busy={busy === 'approve'} onClick={() => void approve()}>Approve exactly this</Button>
              <Button variant="quiet" onClick={() => setReviewing(false)} disabled={busy !== null}>Back to editing</Button>
            </div>
          </div>
        ) : null}
      </div>

      {!locked ? (
        <footer className="compose-foot">
          <div className="compose-state" role="status" aria-live="polite">
            {approvedButEdited ? (
              <span className="state-warn"><Icon name="alert" size="sm" /> You edited an approved draft. Save, then approve again.</span>
            ) : saved?.status === 'approved' ? (
              <span className="state-ok"><Icon name="check" size="sm" /> Approved {formatDateTime(saved.approvedAt)}: this exact text will be sent.</span>
            ) : dirty ? (
              <span className="muted">Unsaved changes</span>
            ) : saved ? (
              <span className="muted">Saved</span>
            ) : (
              <span className="muted">Step 1: review and approve. Step 2: send.{fixture ? ' Sample mailbox: nothing is delivered.' : ''}</span>
            )}
          </div>
          <Button variant="quiet" busy={busy === 'save'} disabled={!dirty || busy !== null} onClick={() => void save()}>
            {saved ? 'Save changes' : 'Save draft'}
          </Button>
          {saved?.status !== 'approved' || dirty ? (
            <Button variant="primary" icon="eye" disabled={!canApprove || busy !== null || reviewing} onClick={() => void startReview()} title={!canApprove ? 'Add a valid recipient, a subject and a message first.' : undefined}>
              Review &amp; approve
            </Button>
          ) : null}
          <Button variant={saved?.status === 'approved' && !dirty ? 'primary' : 'default'} icon="send" busy={busy === 'send'} disabled={saved?.status !== 'approved' || dirty || busy !== null} onClick={() => void send()} title={saved?.status !== 'approved' || dirty ? 'Approve the saved draft first' : undefined}>
            {fixture ? 'Send (record locally)' : 'Send'}
          </Button>
        </footer>
      ) : (
        <footer className="compose-foot">
          <span className="spacer" />
          <Button onClick={onBack}>Done</Button>
        </footer>
      )}
    </section>
  );
}
