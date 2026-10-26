import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OutputFormat, StylePreset } from '@shared/editPlan';
import { api, uploadFile } from '../../api/client';
import { Button, Callout } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { useAiAvailability } from '../../hooks/ai';
import { FORMAT_OPTIONS, STYLE_OPTIONS, plural } from '../../lib/format';
import { EXAMPLES, VIDEO_EXT, extOf, titleFromDescription } from '../../lib/studio';

type FileStatus = 'pending' | 'uploading' | 'done' | 'error';
interface Item {
  key: number;
  file: File;
  url: string;
  kind: 'video';
  status: FileStatus;
  progress: number;
  error?: string;
}

let nextKey = 1;

export function Composer() {
  const nav = useNavigate();
  const toast = useToast();
  const ai = useAiAvailability();

  const [clips, setClips] = useState<Item[]>([]);
  const [description, setDescription] = useState('');
  const [preset, setPreset] = useState<StylePreset>('calm-cinematic');
  const [presetTouched, setPresetTouched] = useState(false);
  const [format, setFormat] = useState<OutputFormat>('9:16');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [attention, setAttention] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const projectId = useRef<string | null>(null);
  const clipInput = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  // With AI the description is the main driver, so default to "let my description decide"; without AI the preset matters more.
  useEffect(() => {
    if (!presetTouched && ai.configured === true) setPreset('custom');
  }, [ai.configured, presetTouched]);
  useEffect(() => {
    const all = urls.current;
    return () => all.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const placeholder = useMemo(() => EXAMPLES[Math.floor(Math.random() * 3)]!.text, []);

  const makeItem = (file: File, kind: 'video'): Item => {
    const url = URL.createObjectURL(file);
    urls.current.push(url);
    return { key: nextKey++, file, url, kind, status: 'pending', progress: 0 };
  };

  const addClips = useCallback((files: FileList | File[]) => {
    const good: Item[] = [];
    const bad: string[] = [];
    for (const f of Array.from(files)) {
      const ext = extOf(f.name);
      if (VIDEO_EXT.includes(ext)) good.push(makeItem(f, 'video'));
      else bad.push(`“${f.name}” is not a supported video (${VIDEO_EXT.join(', ')}).`);
    }
    setRejected(bad);
    if (good.length) {
      setClips((c) => [...c, ...good]);
      setAttention(false);
    }
  }, []);

  const move = (key: number, dir: -1 | 1) =>
    setClips((c) => {
      const i = c.findIndex((x) => x.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const n = c.slice();
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const remove = (key: number) => setClips((c) => c.filter((x) => x.key !== key));

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const files = Array.from(e.dataTransfer.files);
    const video = files;
    if (video.length) addClips(video);
  };

  const patch = (key: number, p: Partial<Item>) => setClips((c) => c.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const generate = async (skipFailed = false) => {
    setBusy(true);
    setAttention(false);
    try {
      // 1) project (created once; retries reuse it)
      let id = projectId.current;
      if (!id) {
        setPhase('Creating your project…');
        const d = await api.projects.create({ title: titleFromDescription(description), brief: description.trim(), stylePreset: preset, format });
        id = d.project.id;
        projectId.current = id;
      } else {
        await api.projects.patch(id, { brief: description.trim(), stylePreset: preset, format });
      }

      // 2) upload in the order shown, one at a time
      const pending = clips.filter((c) => c.status === 'pending');
      let failedNow = 0;
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i]!;
        setPhase(`Uploading clip ${i + 1} of ${pending.length}…`);
        patch(c.key, { status: 'uploading', progress: 0 });
        try {
          const res = await uploadFile(id, c.file, (f) => patch(c.key, { progress: f })).promise;
          if (!res.ok) failedNow++;
          patch(c.key, res.ok ? { status: 'done', progress: 1 } : { status: 'error', error: res.error ?? 'The server rejected this file.' });
        } catch (e) {
          failedNow++;
          patch(c.key, { status: 'error', error: (e as Error).message });
        }
      }
      // 3) check what made it
      const fresh = await api.projects.get(id);
      const okClips = fresh.assets.filter((a) => a.kind === 'video' && !a.excluded).length;
      const failed = failedNow > 0 || clips.some((c) => c.status === 'error');
      if (okClips === 0) {
        setPhase('');
        toast.push({ tone: 'err', title: 'No clips could be added', message: 'Check the messages on your clips, remove them, and try again.' });
        return;
      }
      if (failed && !skipFailed) {
        setPhase('');
        setAttention(true);
        return;
      }

      // 4) generate
      setPhase('Starting your video…');
      const instruction = description.trim();
      await api.versions.create(id, instruction ? { instruction } : {});
      nav(`/studio/${id}`);
    } catch (e) {
      setPhase('');
      toast.error(e, 'Could not start your video');
    } finally {
      setBusy(false);
    }
  };

  const failedCount = clips.filter((c) => c.status === 'error').length;
  const canGo = clips.some((c) => c.status !== 'error') && !busy;
  const styleBlurb = STYLE_OPTIONS.find((s) => s.id === preset)?.blurb;

  return (
    <section className="composer" aria-labelledby="composer-h" onDragOver={(e) => { if (!busy) { e.preventDefault(); setDragging(true); } }} onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <header className="composer-head">
        <h1 id="composer-h">Make a video</h1>
        <p className="muted">Add your clips, describe the video you want, and Amir SM edits it for you to review.</p>
      </header>

      <div className={`composer-card${dragging ? ' composer-drag' : ''}`}>
        {/* 1. clips */}
        <div className="cstep">
          <span className="cstep-n">1</span>
          <h2>Add your clips</h2>
        </div>
        {clips.length === 0 ? (
          <button type="button" className="bigdrop" onClick={() => clipInput.current?.click()} disabled={busy}>
            <span className="bigdrop-mark">
              <Icon name="upload" size="lg" />
            </span>
            <span className="bigdrop-title">Drop your clips here</span>
            <span className="bigdrop-sub">or click to choose files · {VIDEO_EXT.join(' ')}</span>
          </button>
        ) : (
          <ol className="strip" aria-label="Your clips, in order">
            {clips.map((c, i) => (
              <li key={c.key} className={`tile tile-${c.status}`}>
                <div className="tile-media">
                  <video src={`${c.url}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} />
                  <span className="tile-n">{i + 1}</span>
                  {c.status === 'pending' || c.status === 'error' ? (
                    <button type="button" className="tile-x" aria-label={`Remove ${c.file.name}`} onClick={() => remove(c.key)} disabled={busy}>
                      <Icon name="x" size="sm" />
                    </button>
                  ) : null}
                  {c.status === 'uploading' ? <span className="tile-bar"><span style={{ width: `${Math.round(c.progress * 100)}%` }} /></span> : null}
                  {c.status === 'done' ? <span className="tile-ok" aria-label="Uploaded"><Icon name="check" size="sm" /></span> : null}
                </div>
                <div className="tile-name truncate" title={c.file.name}>{c.file.name}</div>
                {c.status === 'error' ? (
                  <div className="tile-err" role="alert">{c.error}</div>
                ) : c.status === 'pending' ? (
                  <div className="tile-move">
                    <button type="button" aria-label={`Move ${c.file.name} earlier`} onClick={() => move(c.key, -1)} disabled={busy || i === 0}><Icon name="arrow-left" size="sm" /></button>
                    <button type="button" aria-label={`Move ${c.file.name} later`} onClick={() => move(c.key, 1)} disabled={busy || i === clips.length - 1}><Icon name="arrow-right" size="sm" /></button>
                  </div>
                ) : null}
              </li>
            ))}
            <li className="tile tile-add">
              <button type="button" className="tile-addbtn" onClick={() => clipInput.current?.click()} disabled={busy}>
                <Icon name="plus" size="lg" />
                <span>Add more</span>
              </button>
            </li>
          </ol>
        )}
        <input ref={clipInput} type="file" multiple accept={`${VIDEO_EXT.join(',')},video/*`} className="sr-only" tabIndex={-1} aria-label="Choose video clips" onChange={(e) => { if (e.target.files) addClips(e.target.files); e.target.value = ''; }} />

        {rejected.length ? (
          <ul className="rejects" role="alert">
            {rejected.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        ) : null}

        {/* 2. describe */}
        <div className="cstep" style={{ marginTop: 'var(--s-6)' }}>
          <span className="cstep-n">2</span>
          <h2><label htmlFor="describe">Describe the video you want</label></h2>
        </div>
        <textarea id="describe" className="textarea composer-text" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`e.g. ${placeholder}`} maxLength={5000} disabled={busy} />
        <div className="examples" aria-label="Examples">
          <span className="tiny faint">Try:</span>
          {EXAMPLES.map((x) => (
            <button key={x.label} type="button" className="eg" onClick={() => setDescription(x.text)} disabled={busy}>
              {x.label}
            </button>
          ))}
        </div>
        {ai.configured === false ? (
          <p className="tiny muted ai-off">
            AI is off, so your description can’t be interpreted. You’ll get a Basic auto-edit that uses the style below and your clip order. Text you put in “quotes” becomes an on-screen title.
          </p>
        ) : null}

        {/* 3. style + generate */}
        <div className="cstep" style={{ marginTop: 'var(--s-6)' }}>
          <span className="cstep-n">3</span>
          <h2>Pick a style <span className="faint" style={{ fontWeight: 400 }}>(optional)</span></h2>
        </div>
        <div className="chips" role="radiogroup" aria-label="Style">
          {STYLE_OPTIONS.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={preset === s.id} className={`pill${preset === s.id ? ' pill-on' : ''}`} onClick={() => { setPreset(s.id); setPresetTouched(true); }} disabled={busy}>
              {s.label}
            </button>
          ))}
        </div>
        {styleBlurb ? <p className="tiny muted" style={{ marginTop: 8 }}>{styleBlurb}</p> : null}

        {attention ? (
          <Callout tone="warn" title={`${plural(failedCount || 1, 'clip')} couldn’t be added`}>
            See the messages on the clips above. You can remove them, or carry on with the clips that worked.
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="primary" onClick={() => void generate(true)} busy={busy}>Continue without them</Button>
            </div>
          </Callout>
        ) : null}

        <div className="gen-row">
          <label className="fmt">
            <span className="tiny muted">Format</span>
            <select className="select select-sm" value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)} disabled={busy} aria-label="Output format">
              {FORMAT_OPTIONS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
          </label>
          <span className="spacer" />
          <div className="gen-status" role="status" aria-live="polite">
            {busy ? phase : clips.length === 0 ? 'Add at least one clip to begin.' : `${plural(clips.filter((c) => c.status !== 'error').length, 'clip')} ready`}
          </div>
          <Button variant="primary" size="lg" icon={busy ? undefined : 'play'} busy={busy} disabled={!canGo} onClick={() => void generate()}>
            Generate
          </Button>
        </div>
      </div>
    </section>
  );
}
