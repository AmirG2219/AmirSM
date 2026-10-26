import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ChatMessageDTO, ProjectDetail, ProjectDTO, VersionDTO } from '@shared/api';
import { api } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Mark } from '../../components/Logo';
import { useToast } from '../../components/Toast';
import { Badge, ProgressBar } from '../../components/ui';
import { isActiveStatus, versionStatusInfo } from '../../lib/format';
import { EXAMPLES, VIDEO_EXT } from '../../lib/studio';
import { uploadAll, type Pending } from './FootageStrip';

interface Attached { id: string; name: string; role: 'footage' | 'reference' }

export function Chat({
  project, detail, messages, setMessages, aiConfigured, archived, busy, onChanged, onVersion, onOpenVersion,
}: {
  project: ProjectDTO;
  detail: ProjectDetail;
  messages: ChatMessageDTO[];
  setMessages: Dispatch<SetStateAction<ChatMessageDTO[]>>;
  aiConfigured: boolean | null;
  archived: boolean;
  busy: boolean;
  onChanged: () => Promise<void> | void;
  onVersion: (v: VersionDTO) => void;
  onOpenVersion: (versionId: string) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<Attached[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [thinking, setThinking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [drag, setDrag] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const clipInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const hasClips = detail.assets.some((a) => a.role === 'footage' && !a.excluded);

  useEffect(() => {
    if (!messages.length && !thinking) return;
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, thinking, pending.length]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const addFiles = async (files: File[], role: 'footage' | 'reference') => {
    setMenu(false);
    const done = await uploadAll(project.id, files, role, setPending, toast);
    if (done.length) {
      setAttached((a) => [...a, ...done.map((d) => ({ ...d, role }))]);
      await onChanged();
    }
  };

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!body || thinking || pending.length) return;
    const ids = attached.map((a) => a.id);
    // show the owner's message immediately
    const temp: ChatMessageDTO = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      text: body,
      attachments: attached.map((a) => ({ assetId: a.id, name: a.name, role: a.role, thumbUrl: null })),
      versionId: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, temp]);
    setText('');
    setAttached([]);
    setThinking(true);
    try {
      const r = await api.chat.send(project.id, body, ids);
      setMessages((m) => [...m.filter((x) => x.id !== temp.id), ...r.messages]);
      if (r.version) onVersion(r.version);
      else await onChanged();
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== temp.id));
      setText(body);
      toast.error(e, 'Could not send');
    } finally {
      setThinking(false);
      area.current?.focus();
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (archived) return;
    void addFiles(Array.from(e.dataTransfer.files), 'footage');
  };

  const versionById = new Map(detail.versions.map((v) => [v.id, v]));
  const placeholder = !hasClips ? 'Add your clips, then tell me what to make…' : messages.length ? 'Ask for a change, or describe the next idea…' : 'Describe the video you want…';

  return (
    <div className={`chat${drag ? ' chat-drag' : ''}`} onDragOver={(e) => { e.preventDefault(); if (!archived) setDrag(true); }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false); }} onDrop={onDrop}>
      {drag ? <div className="chat-drop"><Icon name="upload" /> Drop clips to add them to this video</div> : null}

      <div className="chat-scroll" role="log" aria-live="polite" aria-label="Conversation">
        {!messages.length ? (
          <div className="chat-welcome">
            <Mark large />
            <h2>What are we making?</h2>
            <p className="muted">
              I am your video editor. Add your clips above, tell me the idea in your own words, and I will cut a first draft. You can also attach an example video with the paperclip, and I will match its pacing and style. Then tell me what to change until it feels right.
            </p>
            <div className="chips">
              {EXAMPLES.slice(0, 5).map((ex) => (
                <button key={ex.label} className="chip" disabled={!hasClips || archived} onClick={() => setText(ex.text)} title={hasClips ? 'Use this as a starting point' : 'Add clips first'}>
                  {ex.label}
                </button>
              ))}
            </div>
            {aiConfigured === false ? <Badge tone="warn">AI is off: I can only make a basic edit. Add ANTHROPIC_API_KEY in Settings to unlock my full editor.</Badge> : null}
          </div>
        ) : (
          <ul className="msgs">
            {messages.map((m) => {
              const v = m.versionId ? versionById.get(m.versionId) : undefined;
              return (
                <li key={m.id} className={`msg msg-${m.role}`}>
                  {m.role === 'agent' ? <span className="avatar" aria-hidden="true"><Mark /></span> : null}
                  <div className="bubble">
                    <p>{m.text}</p>
                    {m.attachments.length ? (
                      <ul className="attach-chips">
                        {m.attachments.map((a) => (
                          <li key={a.assetId} className={a.role === 'reference' ? 'ref' : ''}>
                            <Icon name="film" />
                            <span>{a.name}</span>
                            <em>{a.role === 'reference' ? 'example' : 'clip'}</em>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {v ? <DraftCard v={v} onOpen={() => onOpenVersion(v.id)} /> : null}
                  </div>
                </li>
              );
            })}
            {thinking ? (
              <li className="msg msg-agent">
                <span className="avatar" aria-hidden="true"><Mark /></span>
                <div className="bubble thinking" aria-label="The editor is thinking"><span /><span /><span /></div>
              </li>
            ) : null}
          </ul>
        )}
        <div ref={endRef} />
      </div>

      <div className="composer2">
        {attached.length || pending.length ? (
          <ul className="attach-chips tray">
            {attached.map((a) => (
              <li key={a.id} className={a.role === 'reference' ? 'ref' : ''}>
                <Icon name="film" />
                <span>{a.name}</span>
                <em>{a.role === 'reference' ? 'example' : 'clip'}</em>
                <button aria-label={`Remove ${a.name} from this message`} onClick={() => setAttached((x) => x.filter((y) => y.id !== a.id))}><Icon name="x" /></button>
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.key} className="uploading">
                <span>{p.name}</span>
                <ProgressBar value={p.progress} label={`Uploading ${p.name}`} thin />
              </li>
            ))}
          </ul>
        ) : null}
        <div className="c2-row">
          <div className="c2-attach">
            <button className="c2-icon" aria-label="Attach a video" aria-expanded={menu} disabled={archived} onClick={() => setMenu((o) => !o)}>
              <Icon name="paperclip" />
            </button>
            {menu ? (
              <div className="c2-menu" role="menu">
                <button role="menuitem" onClick={() => clipInput.current?.click()}>
                  <strong>Add my clips</strong>
                  <span>Footage to edit</span>
                </button>
                <button role="menuitem" onClick={() => refInput.current?.click()}>
                  <strong>Show an example</strong>
                  <span>A video whose style you like</span>
                </button>
              </div>
            ) : null}
            <input ref={clipInput} type="file" accept={VIDEO_EXT.join(',')} multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files ?? []), 'footage'); e.target.value = ''; }} />
            <input ref={refInput} type="file" accept={VIDEO_EXT.join(',')} multiple hidden onChange={(e) => { void addFiles(Array.from(e.target.files ?? []), 'reference'); e.target.value = ''; }} />
          </div>
          <textarea
            ref={area}
            className="c2-text"
            rows={1}
            value={text}
            placeholder={archived ? 'This video is archived.' : placeholder}
            aria-label="Message your video editor"
            disabled={archived}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="c2-send" aria-label="Send" disabled={!text.trim() || thinking || archived || pending.length > 0} onClick={() => void send()}>
            <Icon name="send" />
          </button>
        </div>
        <p className="c2-foot tiny faint">
          {busy ? 'A draft is being made. You can keep chatting; changes start once it finishes.' : 'Enter to send · Shift+Enter for a new line · originals are never changed'}
        </p>
      </div>
    </div>
  );
}

function DraftCard({ v, onOpen }: { v: VersionDTO; onOpen: () => void }) {
  const info = versionStatusInfo(v);
  const active = isActiveStatus(v.status);
  return (
    <button className="draftcard" onClick={onOpen} aria-label={`Open version ${v.number} in the preview`}>
      <span className="dc-n">v{v.number}</span>
      <span className="dc-main">
        <strong>{v.isRevision ? 'Revision' : 'First draft'}</strong>
        <span className="tiny muted">{info.label}{active && v.job ? ` · ${Math.round(v.job.progress * 100)}%` : ''}</span>
        {active ? <ProgressBar value={v.job?.progress ?? null} label={`Version ${v.number} progress`} thin /> : null}
      </span>
      <Icon name="arrow-right" />
    </button>
  );
}
