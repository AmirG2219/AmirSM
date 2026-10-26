import { useRef, useState } from 'react';
import type { ProjectDetail } from '@shared/api';
import { api, uploadFile } from '../../api/client';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { ProgressBar } from '../../components/ui';
import { formatDuration } from '../../lib/format';
import { VIDEO_EXT, extOf } from '../../lib/studio';

export interface Pending { key: string; name: string; progress: number; error?: string }

/** Upload files one at a time (real progress per file). Returns the created assets. */
export async function uploadAll(
  projectId: string,
  files: File[],
  role: 'footage' | 'reference',
  onPending: (fn: (p: Pending[]) => Pending[]) => void,
  toast: ReturnType<typeof useToast>,
) {
  const ok: { id: string; name: string }[] = [];
  for (const file of files) {
    const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
    if (!VIDEO_EXT.includes(extOf(file.name))) {
      toast.push({ tone: 'warn', title: `${file.name} was skipped`, message: `Only video files are supported (${VIDEO_EXT.join(', ')}).` });
      continue;
    }
    onPending((p) => [...p, { key, name: file.name, progress: 0 }]);
    try {
      const r = await uploadFile(projectId, file, (f) => onPending((p) => p.map((x) => (x.key === key ? { ...x, progress: f } : x))), role).promise;
      if (r.ok && r.asset) ok.push({ id: r.asset.id, name: r.asset.originalName });
      else toast.push({ tone: 'err', title: `${file.name} could not be added`, message: r.error });
    } catch (e) {
      toast.error(e, `${file.name} could not be uploaded`);
    } finally {
      onPending((p) => p.filter((x) => x.key !== key));
    }
  }
  return ok;
}

/** The clips the editor works from: thumbnails, add more, remove (exclude) — originals are always kept. */
export function FootageStrip({ detail, onChanged, locked }: { detail: ProjectDetail; onChanged: () => Promise<void> | void; locked: boolean }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [open, setOpen] = useState(true);
  const clips = detail.assets.filter((a) => a.role === 'footage' && a.kind === 'video').sort((a, b) => a.sortOrder - b.sortOrder);
  const active = clips.filter((c) => !c.excluded);

  const add = async (files: File[]) => {
    if (!files.length) return;
    await uploadAll(detail.project.id, files, 'footage', (fn) => setPending(fn), toast);
    await onChanged();
  };
  const toggle = async (id: string, excluded: boolean) => {
    try {
      await api.assets.patch(id, { excluded });
      await onChanged();
    } catch (e) {
      toast.error(e, 'Could not update the clip');
    }
  };

  return (
    <div className="fs">
      <button className="fs-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="film" />
        <strong>Your clips</strong>
        <span className="muted tiny">{active.length ? `${active.length} in the edit` : 'none yet'}</span>
        <span className="grow" />
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </button>
      {open ? (
        <div className="fs-body">
          {!clips.length && !pending.length && !locked ? (
            <button className="fs-empty" onClick={() => input.current?.click()}>
              <Icon name="upload" />
              <span><strong>Add your clips</strong><em>or drop them anywhere here. Your originals are never changed.</em></span>
            </button>
          ) : null}
          <ul className="fs-list" hidden={!clips.length && !pending.length}>
            {clips.map((c) => (
              <li key={c.id} className={c.excluded ? 'off' : ''}>
                <div className="fs-thumb" title={c.originalName}>
                  {c.thumbUrl ? <img src={c.thumbUrl} alt="" /> : <Icon name="film" />}
                  <span className="fs-dur">{formatDuration(c.info.durationMs)}</span>
                  {!locked ? (
                    <button className="fs-x" aria-label={c.excluded ? `Use ${c.originalName} again` : `Leave ${c.originalName} out`} title={c.excluded ? 'Use again' : 'Leave out'} onClick={() => toggle(c.id, !c.excluded)}>
                      <Icon name={c.excluded ? 'plus' : 'x'} />
                    </button>
                  ) : null}
                </div>
                <span className="fs-name">{c.originalName}</span>
              </li>
            ))}
            {pending.map((p) => (
              <li key={p.key}>
                <div className="fs-thumb fs-pending">
                  <ProgressBar value={p.progress} label={`Uploading ${p.name}`} thin />
                </div>
                <span className="fs-name">{p.name}</span>
              </li>
            ))}
            {!locked ? (
              <li>
                <button className="fs-add" onClick={() => input.current?.click()}>
                  <Icon name="plus" />
                  <span>Add clips</span>
                </button>
              </li>
            ) : null}
          </ul>
          <input ref={input} type="file" accept={VIDEO_EXT.join(',')} multiple hidden onChange={(e) => { void add(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </div>
      ) : null}
    </div>
  );
}
