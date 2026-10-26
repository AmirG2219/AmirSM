import { Link } from 'react-router-dom';
import type { ProjectSummary } from '@shared/api';
import { Icon } from './Icon';
import { ProgressBar, StatusPill } from './ui';
import { PROJECT_STATUS, VERSION_STATUS, isActiveStatus, plural, relativeTime } from '../lib/format';

export function Thumb({ url, alt = '', ratio = '9 / 16' }: { url: string | null; alt?: string; ratio?: string }) {
  return (
    <div className="thumb" style={{ aspectRatio: ratio }}>
      {url ? <img src={url} alt={alt} decoding="async" /> : <Icon name="film" className="thumb-empty" />}
    </div>
  );
}

/** A past video: thumbnail, title, status, date. */
export function ProjectCard({ p }: { p: ProjectSummary }) {
  const st = PROJECT_STATUS[p.status];
  const lv = p.latestVersion;
  const active = lv ? isActiveStatus(lv.status) : false;
  return (
    <Link to={`/studio/${p.id}`} className="pcard">
      <div className="pcard-media">
        <Thumb url={p.thumbUrl} ratio="4 / 5" />
        <div className="pcard-badge">
          <StatusPill label={st.label} tone={st.tone} active={p.status === 'processing'} />
        </div>
      </div>
      <div className="pcard-body">
        <h3 className="truncate" title={p.title}>
          {p.title}
        </h3>
        {active && lv ? (
          <div className="stack-s" style={{ gap: 6 }}>
            <ProgressBar value={lv.progress} label={`Progress of version ${lv.number}`} thin indeterminate={lv.progress == null || lv.status === 'queued'} />
            <div className="tiny muted">
              {VERSION_STATUS[lv.status].label}
              {lv.progress != null && lv.status !== 'queued' ? ` · ${Math.round(lv.progress * 100)}%` : ''}
            </div>
          </div>
        ) : (
          <div className="tiny muted truncate">
            {relativeTime(p.updatedAt)} · {plural(p.versionCount, 'version')}
          </div>
        )}
      </div>
    </Link>
  );
}
