import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import type { AssetDTO } from '@shared/api';
import { api, ApiError, uploadFile } from '../../api/client';
import { Badge, Button, Callout, EmptyState, IconButton, ProgressBar } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { Thumb } from '../../components/ProjectCard';
import { formatBytes, formatDuration } from '../../lib/format';

const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const AUDIO_EXT = ['.mp3', '.m4a', '.wav', '.aac'];
const MAX_PARALLEL = 1; // sequential: clips keep the order they were chosen in

type UploadStatus = 'queued' | 'uploading' | 'processing' | 'done' | 'error';
interface UploadRow {
  key: number;
  name: string;
  size: number;
  kind: 'video' | 'audio';
  status: UploadStatus;
  progress: number;
  error?: string;
}

const extOf = (n: string) => {
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i).toLowerCase();
};

export function FootageStep({
  projectId,
  assets,
  archived,
  hasVersions,
  onChanged,
  onContinue,
}: {
  projectId: string;
  assets: AssetDTO[];
  archived: boolean;
  hasVersions: boolean;
  onChanged: () => Promise<void> | void;
  onContinue: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<UploadRow[]>([]);
  const queue = useRef<{ key: number; file: File }[]>([]);
  const running = useRef(0);
  const nextKey = useRef(1);
  const [dragging, setDragging] = useState<'video' | 'audio' | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [busyAsset, setBusyAsset] = useState<string | null>(null);

  const videos = assets.filter((a) => a.kind === 'video').sort((a, b) => a.sortOrder - b.sortOrder);
  const audios = assets.filter((a) => a.kind === 'audio').sort((a, b) => a.sortOrder - b.sortOrder);
  const included = videos.filter((a) => !a.excluded);
  const totalSec = included.reduce((n, a) => n + a.info.durationMs, 0);

  const patchRow = useCallback((key: number, p: Partial<UploadRow>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...p } : x))), []);

  const pump = useCallback(() => {
    while (running.current < MAX_PARALLEL && queue.current.length) {
      const job = queue.current.shift()!;
      running.current++;
      patchRow(job.key, { status: 'uploading', progress: 0 });
      const { promise } = uploadFile(projectId, job.file, (f) => patchRow(job.key, { progress: f, status: f >= 1 ? 'processing' : 'uploading' }));
      promise
        .then(async (res) => {
          if (res.ok) {
            patchRow(job.key, { status: 'done', progress: 1 });
            await onChanged();
          } else {
            patchRow(job.key, { status: 'error', error: res.error ?? 'The server rejected this file.' });
          }
        })
        .catch((e: Error) => {
          patchRow(job.key, { status: 'error', error: e instanceof ApiError ? e.message : e.message });
          if (e instanceof ApiError && e.status === 409) toast.error(e);
        })
        .finally(() => {
          running.current--;
          pump();
        });
    }
  }, [projectId, patchRow, onChanged, toast]);

  const addFiles = useCallback(
    (files: FileList | File[], want: 'video' | 'audio') => {
      const list = Array.from(files);
      if (!list.length) return;
      const newRows: UploadRow[] = [];
      for (const f of list) {
        const key = nextKey.current++;
        const ext = extOf(f.name);
        const kind: 'video' | 'audio' = AUDIO_EXT.includes(ext) ? 'audio' : 'video';
        const allowed = want === 'video' ? VIDEO_EXT : AUDIO_EXT;
        if (!allowed.includes(ext)) {
          newRows.push({
            key, name: f.name, size: f.size, kind, status: 'error', progress: 0,
            error: `Unsupported file type “${ext || 'none'}”. ${want === 'video' ? 'Video' : 'Audio'} files only: ${allowed.join(', ')}`,
          });
          continue;
        }
        newRows.push({ key, name: f.name, size: f.size, kind: want, status: 'queued', progress: 0 });
        queue.current.push({ key, file: f });
      }
      setRows((r) => [...newRows, ...r]);
      pump();
    },
    [pump],
  );

  // Warn before closing the tab mid-upload.
  const uploading = rows.some((r) => r.status === 'queued' || r.status === 'uploading' || r.status === 'processing');
  useEffect(() => {
    if (!uploading) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [uploading]);

  const onDrop = (e: DragEvent, want: 'video' | 'audio') => {
    e.preventDefault();
    setDragging(null);
    if (archived) return;
    addFiles(e.dataTransfer.files, want);
  };

  const toggleExcluded = async (a: AssetDTO) => {
    setBusyAsset(a.id);
    try {
      await api.assets.patch(a.id, { excluded: !a.excluded });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not update the clip');
    } finally {
      setBusyAsset(null);
    }
  };

  const move = async (a: AssetDTO, dir: -1 | 1) => {
    const i = videos.findIndex((x) => x.id === a.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= videos.length) return;
    const order = videos.map((x) => x.sortOrder);
    const next = videos.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    // Re-use the existing sortOrder values in their sorted order so ordering stays consistent with audio assets.
    const slots = [...order].sort((x, y) => x - y);
    const changes = next.map((x, idx) => ({ id: x.id, sortOrder: slots[idx]! })).filter((c, idx) => videos[idx]!.id !== c.id || c.sortOrder !== videos[idx]!.sortOrder);
    setBusyAsset(a.id);
    try {
      // two-step to avoid duplicate transient values mattering: sequential patches
      for (const c of changes) await api.assets.patch(c.id, { sortOrder: c.sortOrder });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not reorder clips');
      await onChanged();
    } finally {
      setBusyAsset(null);
    }
  };

  const dismissRow = (key: number) => setRows((r) => r.filter((x) => x.key !== key));

  return (
    <div className="stack-l">
      {archived ? (
        <Callout tone="info" title="This project is archived">
          Unarchive it from the header to add or change footage. Existing files are kept.
        </Callout>
      ) : null}

      <section className="card" aria-labelledby="footage-up">
        <div className="card-head">
          <Icon name="upload" className="faint" />
          <h2 id="footage-up">Add your footage</h2>
        </div>
        <div className="card-body stack">
          <DropZone
            kind="video"
            disabled={archived}
            dragging={dragging === 'video'}
            onDragState={(on) => setDragging(on ? 'video' : null)}
            onDrop={(e) => onDrop(e, 'video')}
            onFiles={(f) => addFiles(f, 'video')}
            title="Drop video clips here"
            hint={`or choose files · ${VIDEO_EXT.join(' ')}`}
            accept={VIDEO_EXT.join(',') + ',video/*'}
            buttonLabel="Choose video files"
          />
          <p className="small muted">
            Your originals are preserved exactly as uploaded and never modified; edits are rendered as separate files. Clips are read on this machine only.
          </p>
          {rows.length ? (
            <ul className="uploads" aria-label="Uploads">
              {rows.map((r) => (
                <li key={r.key} className={`upload upload-${r.status}`}>
                  <Icon name={r.kind === 'audio' ? 'music' : 'film'} className="faint" />
                  <div className="upload-main">
                    <div className="row-nowrap" style={{ gap: 8 }}>
                      <span className="truncate" style={{ fontWeight: 600 }} title={r.name}>
                        {r.name}
                      </span>
                      <span className="tiny faint nowrap">{formatBytes(r.size)}</span>
                    </div>
                    {r.status === 'error' ? (
                      <div className="small" style={{ color: 'var(--err)' }} role="alert">
                        {r.error}
                      </div>
                    ) : r.status === 'done' ? (
                      <div className="small" style={{ color: 'var(--ok)' }}>
                        Added to the project
                      </div>
                    ) : (
                      <div className="stack-s" style={{ gap: 4 }}>
                        <ProgressBar value={r.status === 'processing' ? null : r.progress} label={`Uploading ${r.name}`} thin indeterminate={r.status === 'processing'} />
                        <div className="tiny muted" aria-live="polite">
                          {r.status === 'queued'
                            ? 'Waiting to upload'
                            : r.status === 'processing'
                              ? 'Uploaded. Reading the file and making a thumbnail…'
                              : `${Math.round(r.progress * 100)}%`}
                        </div>
                      </div>
                    )}
                  </div>
                  {r.status === 'done' || r.status === 'error' ? <IconButton icon="x" label={`Dismiss ${r.name}`} size="sm" onClick={() => dismissRow(r.key)} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <section className="card" aria-labelledby="footage-list">
        <div className="card-head">
          <Icon name="film" className="faint" />
          <div>
            <h2 id="footage-list">Clips</h2>
            {videos.length ? (
              <div className="small muted">
                {included.length} of {videos.length} included · {formatDuration(totalSec)} of footage
              </div>
            ) : null}
          </div>
          <span className="spacer" />
          {included.length > 0 && !hasVersions ? (
            <Button variant="primary" size="sm" onClick={onContinue}>
              Continue to brief
            </Button>
          ) : null}
        </div>
        {hasVersions ? (
          <div className="card-body" style={{ paddingBottom: 0 }}>
            <Callout tone="info">Changes to included clips and their order apply to the next draft or revision. Existing versions are not re-rendered.</Callout>
          </div>
        ) : null}
        {videos.length === 0 ? (
          <div className="card-body">
            <EmptyState compact title="No clips yet">
              Add at least one video clip above. You can include or skip clips and set their order afterwards.
            </EmptyState>
          </div>
        ) : (
          <ol className="clips">
            {videos.map((a, idx) => (
              <li key={a.id} className={`clip${a.excluded ? ' clip-excluded' : ''}`}>
                <div className="clip-order tiny faint" aria-hidden="true">
                  {idx + 1}
                </div>
                <button type="button" className="clip-thumb" onClick={() => setPreviewId(previewId === a.id ? null : a.id)} aria-expanded={previewId === a.id} aria-label={`${previewId === a.id ? 'Hide' : 'Preview'} ${a.originalName}`}>
                  <Thumb url={a.thumbUrl} ratio="9 / 16" />
                  <span className="clip-play">
                    <Icon name={previewId === a.id ? 'x' : 'play'} />
                  </span>
                </button>
                <div className="clip-main">
                  <div className="truncate" style={{ fontWeight: 600 }} title={a.originalName}>
                    {a.originalName}
                  </div>
                  <div className="clip-meta">
                    <span>{formatDuration(a.info.durationMs)}</span>
                    <span>
                      {a.info.displayWidth || a.info.width}×{a.info.displayHeight || a.info.height}
                    </span>
                    <span>{formatBytes(a.sizeBytes)}</span>
                    {a.info.hasAudio ? <Badge tone="ok">Has audio</Badge> : <Badge>No audio</Badge>}
                    {a.excluded ? <Badge tone="warn">Not included</Badge> : null}
                  </div>
                  {previewId === a.id ? (
                    <video className="clip-video" controls preload="metadata" playsInline src={a.fileUrl} poster={a.thumbUrl ?? undefined}>
                      Your browser can’t play this clip.
                    </video>
                  ) : null}
                </div>
                <div className="clip-actions">
                  <label className="check" title={a.excluded ? 'Include this clip in the edit' : 'Exclude this clip from the edit'}>
                    <input type="checkbox" checked={!a.excluded} disabled={busyAsset === a.id || archived} onChange={() => void toggleExcluded(a)} />
                    <span>Include</span>
                  </label>
                  <div className="row-nowrap" style={{ gap: 2 }}>
                    <IconButton icon="arrow-up" label={`Move ${a.originalName} earlier`} size="sm" disabled={idx === 0 || busyAsset !== null || archived} onClick={() => void move(a, -1)} />
                    <IconButton icon="arrow-down" label={`Move ${a.originalName} later`} size="sm" disabled={idx === videos.length - 1 || busyAsset !== null || archived} onClick={() => void move(a, 1)} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card" aria-labelledby="footage-music">
        <div className="card-head">
          <Icon name="music" className="faint" />
          <div>
            <h2 id="footage-music">Your music</h2>
            <div className="small muted">Optional. Amir SM never supplies music; upload audio you have the rights to use.</div>
          </div>
        </div>
        <div className="card-body stack">
          <DropZone
            kind="audio"
            compact
            disabled={archived}
            dragging={dragging === 'audio'}
            onDragState={(on) => setDragging(on ? 'audio' : null)}
            onDrop={(e) => onDrop(e, 'audio')}
            onFiles={(f) => addFiles(f, 'audio')}
            title="Drop an audio track"
            hint={AUDIO_EXT.join(' ')}
            accept={AUDIO_EXT.join(',') + ',audio/*'}
            buttonLabel="Choose audio file"
          />
          {audios.length ? (
            <ul className="stack-s">
              {audios.map((a) => (
                <li key={a.id} className={`clip clip-audio${a.excluded ? ' clip-excluded' : ''}`}>
                  <Icon name="music" className="faint" />
                  <div className="clip-main">
                    <div className="truncate" style={{ fontWeight: 600 }} title={a.originalName}>
                      {a.originalName}
                    </div>
                    <div className="clip-meta">
                      <span>{formatDuration(a.info.durationMs)}</span>
                      <span>{formatBytes(a.sizeBytes)}</span>
                      <Badge tone="info">Your music</Badge>
                      {a.excluded ? <Badge tone="warn">Not included</Badge> : null}
                    </div>
                    <audio controls preload="none" src={a.fileUrl} style={{ width: '100%', marginTop: 8 }} />
                  </div>
                  <div className="clip-actions">
                    <label className="check">
                      <input type="checkbox" checked={!a.excluded} disabled={busyAsset === a.id || archived} onChange={() => void toggleExcluded(a)} />
                      <span>Include</span>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function DropZone({
  kind, title, hint, accept, buttonLabel, disabled, dragging, onDragState, onDrop, onFiles, compact,
}: {
  kind: 'video' | 'audio';
  title: string;
  hint: string;
  accept: string;
  buttonLabel: string;
  disabled?: boolean;
  dragging: boolean;
  compact?: boolean;
  onDragState: (on: boolean) => void;
  onDrop: (e: DragEvent) => void;
  onFiles: (f: FileList) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`dropzone${dragging ? ' dropzone-on' : ''}${compact ? ' dropzone-compact' : ''}`}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        onDragState(true);
      }}
      onDragLeave={() => onDragState(false)}
      onDrop={onDrop}
    >
      <div className="dropzone-mark">
        <Icon name={kind === 'audio' ? 'music' : 'upload'} />
      </div>
      <div className="dropzone-text">
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div className="small muted">{hint}</div>
      </div>
      <Button onClick={() => input.current?.click()} disabled={disabled} icon="plus">
        {buttonLabel}
      </Button>
      <input
        ref={input}
        type="file"
        multiple={kind === 'video'}
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-label={buttonLabel}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
