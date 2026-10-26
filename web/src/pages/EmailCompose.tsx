import { useMemo, useRef, useState } from 'react';
import type { EmailAccountDTO, EmailDraftDTO, EmailThreadDetail } from '@shared/api';
import { api } from '../api/client';
import { Badge, Button, Callout, Card, CardHeader, Input, Select, Textarea } from '../components/ui';
import { useToast } from '../components/Toast';
import type { AiAvailability } from '../hooks/ai';
import { formatDateTime } from '../lib/format';

const TONES = ['friendly', 'professional', 'warm', 'concise', 'formal'];

export const parseAddrs = (s: string) =>
  s
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function draftStatusBadge(d: Pick<EmailDraftDTO, 'status' | 'sendResult'>) {
  if (d.status === 'sent') return d.sendResult?.delivered ? <Badge tone="ok" dot>Sent</Badge> : <Badge tone="warn" dot>Recorded locally, not delivered</Badge>;
  if (d.status === 'approved') return <Badge tone="ok" dot>Approved, not sent</Badge>;
  if (d.status === 'failed') return <Badge tone="err" dot>Send failed</Badge>;
  return <Badge dot>Draft</Badge>;
}

export interface ComposeSeed {
  account: EmailAccountDTO;
  thread?: EmailThreadDetail;
  draft?: EmailDraftDTO;
}

function initialFields(seed: ComposeSeed) {
  if (seed.draft) {
    const d = seed.draft;
    return { to: d.to.join(', '), cc: d.cc.join(', '), subject: d.subject, body: d.body, ai: d.aiAssisted };
  }
  if (seed.thread) {
    const t = seed.thread;
    const lastIn = [...t.messages].reverse().find((m) => m.direction === 'in') ?? t.messages[t.messages.length - 1];
    return { to: lastIn?.fromAddr ?? '', cc: '', subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`, body: '', ai: false };
  }
  return { to: '', cc: '', subject: '', body: '', ai: false };
}

export function ComposePanel({ seed, ai, onBack, onChanged }: { seed: ComposeSeed; ai: AiAvailability; onBack: () => void; onChanged: () => void }) {
  const toast = useToast();
  const init = useMemo(() => initialFields(seed), [seed]);
  const [saved, setSaved] = useState<EmailDraftDTO | null>(seed.draft ?? null);
  const [to, setTo] = useState(init.to);
  const [cc, setCc] = useState(init.cc);
  const [subject, setSubject] = useState(init.subject);
  const [body, setBody] = useState(init.body);
  const [aiAssisted, setAiAssisted] = useState(init.ai);
  const [busy, setBusy] = useState<null | 'save' | 'approve' | 'send' | 'draft' | 'tone'>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [instruction, setInstruction] = useState('');
  const [tone, setTone] = useState('friendly');
  const [aiNote, setAiNote] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const sent = saved?.status === 'sent';
  const account = seed.account;
  const fixture = account.isFixture;
  const threadId = seed.thread?.id ?? seed.draft?.threadId ?? null;

  const current = { to: parseAddrs(to), cc: parseAddrs(cc), subject, body };
  const dirty = !saved
    ? !!(to.trim() || cc.trim() || subject.trim() || body.trim())
    : JSON.stringify([current.to, current.cc, current.subject, current.body]) !== JSON.stringify([saved.to, saved.cc, saved.subject, saved.body]);
  const approvedButEdited = saved?.status === 'approved' && dirty;
  const canApproveNow = current.to.length > 0 && subject.trim() !== '' && body.trim() !== '';
  const aiBlocked = ai.configured === false;

  const save = async (): Promise<EmailDraftDTO | null> => {
    setBusy('save');
    setError(null);
    try {
      const d = saved
        ? await api.email.updateDraft(saved.id, { to: current.to, cc: current.cc, subject, body, aiAssisted })
        : await api.email.createDraft({ accountId: account.id, threadId, to: current.to, cc: current.cc, subject, body, aiAssisted });
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
      const d = await save();
      if (!d) return;
    }
    setReviewing(true);
  };

  const approve = async () => {
    if (!saved) return;
    setBusy('approve');
    setError(null);
    try {
      const d = await api.email.approve(saved.id);
      setSaved(d);
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
      const r = await api.email.aiDraft({ instruction: instruction.trim(), threadId: threadId ?? undefined, tone });
      setSubject(r.subject);
      setBody(r.body);
      setAiAssisted(true);
      setAiNote('The AI wrote this draft. It is not saved or sent. Read it carefully and edit anything you like before approving.');
    } catch (e) {
      setAiNote(null);
      toast.error(e, 'AI drafting failed');
    } finally {
      setBusy(null);
    }
  };

  const adjustTone = async () => {
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
      setAiNote(`Rewrote ${hasSel ? 'the selected text' : 'the whole message'} in a ${tone} tone. Review the result.`);
    } catch (err) {
      toast.error(err, 'Tone change failed');
    } finally {
      setBusy(null);
    }
  };

  const locked = sent;
  const result = saved?.sendResult;

  return (
    <div className="stack-l">
      <div className="row">
        <Button variant="quiet" icon="arrow-left" onClick={onBack}>
          Back
        </Button>
        <h2 className="section-title">{seed.thread ? 'Reply' : seed.draft ? 'Draft' : 'New message'}</h2>
        {approvedButEdited ? <Badge tone="warn" dot>Edited: approval no longer valid</Badge> : saved ? draftStatusBadge(saved) : <Badge>Not saved yet</Badge>}
        {aiAssisted ? <Badge tone="accent">AI-assisted</Badge> : null}
      </div>

      {fixture ? (
        <Callout tone="info" title="Local sample mailbox">
          This sends nothing over the internet. “Sending” only records the message on this machine and says so.
        </Callout>
      ) : null}

      {sent ? (
        <Callout tone={result?.delivered ? 'ok' : 'warn'} title={result?.delivered ? 'Delivered' : 'Recorded locally — NOT delivered'}>
          <p style={{ margin: 0 }}>{result?.note ?? (result?.delivered ? 'The provider accepted the message.' : 'The message was not delivered.')}</p>
          <p className="tiny muted" style={{ marginTop: 4 }}>
            {formatDateTime(saved?.sentAt)}
          </p>
        </Callout>
      ) : null}
      {saved?.status === 'failed' && result ? (
        <Callout tone="err" title="Sending failed">
          {result.note}
        </Callout>
      ) : null}

      {!locked ? (
        <Card as="section" aria-labelledby="ai-assist">
          <CardHeader icon="edit" title={<span id="ai-assist">Writing help</span>} subtitle="Optional. Nothing is ever sent without your approval." />
          <div className="card-body stack">
            {aiBlocked ? (
              <Callout tone="warn" title="AI writing help is unavailable">
                {ai.reason}
              </Callout>
            ) : null}
            <div className="mail-ai">
              <Textarea label="What should the message say?" rows={2} value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={aiBlocked} placeholder="e.g. Thank her, say yes to Saturday morning, ask about parking." maxLength={2000} />
              <Select label="Tone" value={tone} onChange={(e) => setTone(e.target.value)} disabled={aiBlocked}>
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {t[0]!.toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="row">
              <Button icon="edit" busy={busy === 'draft'} disabled={aiBlocked || instruction.trim().length < 3 || busy !== null} onClick={() => void aiDraft()}>
                Draft with AI
              </Button>
              <Button icon="refresh" busy={busy === 'tone'} disabled={aiBlocked || !body.trim() || busy !== null} onClick={() => void adjustTone()} title="Rewrites the selected text, or the whole message if nothing is selected">
                Adjust tone of selection or whole message
              </Button>
            </div>
            {aiNote ? <Callout tone="info">{aiNote}</Callout> : null}
          </div>
        </Card>
      ) : null}

      <Card as="section" aria-labelledby="msg-fields">
        <CardHeader icon="mail" title={<span id="msg-fields">Message</span>} subtitle={`From ${account.address}`} />
        <div className="card-body stack">
          <Input label="To" value={to} onChange={(e) => setTo(e.target.value)} disabled={locked} placeholder="name@example.com, other@example.com" hint="Separate several addresses with commas." />
          <Input label="Cc" optional value={cc} onChange={(e) => setCc(e.target.value)} disabled={locked} />
          <Input label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={locked} maxLength={300} />
          <Textarea ref={bodyRef} label="Body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} disabled={locked} />
          {error ? <Callout tone="err">{error}</Callout> : null}
        </div>
      </Card>

      {!locked ? (
        <section className="card" aria-labelledby="send-flow">
          <CardHeader icon="send" title={<span id="send-flow">Send, in two steps</span>} subtitle="1. Save and approve exactly this text.  2. Send." />
          <div className="card-body stack">
            {approvedButEdited ? (
              <Callout tone="warn" title="You edited an approved draft">
                Saving resets it to a draft. It must be approved again before it can be sent.
              </Callout>
            ) : saved?.status === 'approved' ? (
              <Callout tone="ok" title="Approved: this exact text will be sent">
                Approved {formatDateTime(saved.approvedAt)}. If you change anything, the approval is reset.
              </Callout>
            ) : null}

            {reviewing && saved && saved.status !== 'approved' ? (
              <div className="stack review-box" role="region" aria-label="Exactly what will be sent">
                <div className="eyebrow">Exactly what will be sent</div>
                <dl className="kv">
                  <dt>From</dt>
                  <dd>{account.address}</dd>
                  <dt>To</dt>
                  <dd>{saved.to.join(', ')}</dd>
                  {saved.cc.length ? (
                    <>
                      <dt>Cc</dt>
                      <dd>{saved.cc.join(', ')}</dd>
                    </>
                  ) : null}
                  <dt>Subject</dt>
                  <dd>{saved.subject}</dd>
                </dl>
                <pre className="mail-pre">{saved.body}</pre>
                {fixture ? <p className="small muted">The sample mailbox will not deliver this. Sending only records it locally.</p> : null}
                <div className="row">
                  <Button variant="primary" icon="check" busy={busy === 'approve'} onClick={() => void approve()}>
                    Approve exactly this
                  </Button>
                  <Button variant="quiet" onClick={() => setReviewing(false)} disabled={busy !== null}>
                    Back to editing
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="row">
              <Button icon="check" busy={busy === 'save'} disabled={!dirty || busy !== null} onClick={() => void save()}>
                {saved ? 'Save changes' : 'Save draft'}
              </Button>
              {saved?.status !== 'approved' || dirty ? (
                <Button variant="primary" icon="eye" disabled={!canApproveNow || busy !== null || reviewing} onClick={() => void startReview()}>
                  Review and approve for sending
                </Button>
              ) : null}
              <Button
                variant={saved?.status === 'approved' && !dirty ? 'primary' : 'default'}
                icon="send"
                busy={busy === 'send'}
                disabled={saved?.status !== 'approved' || dirty || busy !== null}
                onClick={() => void send()}
                title={saved?.status !== 'approved' || dirty ? 'Approve the saved draft first' : undefined}
              >
                {fixture ? 'Send (record locally)' : 'Send'}
              </Button>
            </div>
            {dirty ? <p className="tiny muted">You have unsaved changes.</p> : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

