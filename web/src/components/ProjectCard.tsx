import { Link } from 'react-router-dom';
import type { ProjectSummary } from '@shared/api';
import { Icon } from './Icon';
import { ProgressBar, StatusPill } from './ui';
import { PROJECT_STATUS, VERSION_STATUS, isActiveStatus, plural, relativeTime, styleLabel } from '../lib/format';

export function Thumb({ url, alt = '', ratio = '9 / 16' }: { url: string | null; alt?: string; ratio?: string }) {
  return (
    <div className="thumb" style={{ aspectRatio: ratio }}>
      {url ? <img src={url} alt={alt} decoding="async" /> : <Icon name="film" className="thumb-empty" />}
    </div>
  );
}

/** Grid card used in the Studio list. */
export function ProjectCard({ p }: { p: ProjectSummary }) {
  const st = PROJECT_STATUS[p.status];
  const lv = p.latestVersion;
  const active = lv ? isActiveStatus(lv.status) : false;
  return (
    <Link to={`/studio/${p.id}`} className="pcard card">
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
              v{lv.number} · {VERSION_STATUS[lv.status].label}
              {lv.progress != null && lv.status !== 'queued' ? ` · ${Math.round(lv.progress * 100)}%` : ''}
            </div>
          </div>
        ) : (
          <div className="tiny muted truncate">
            {plural(p.versionCount, 'version')} · {plural(p.assetCount, 'clip')}
          </div>
        )}
        <div className="tiny faint truncate">
          {styleLabel(p.stylePreset)} · {p.format} · {relativeTime(p.updatedAt)}
        </div>
      </div>
    </Link>
  );
}

/** Compact horizontal row used on the Home dashboard. */
export function ProjectRow({ p, showProgress }: { p: ProjectSummary; showProgress?: boolean }) {
  const st = PROJECT_STATUS[p.status];
  const lv = p.latestVersion;
  const active = lv ? isActiveStatus(lv.status) : false;
  return (
    <li>
      <Link to={`/studio/${p.id}`} className="prow">
        <Thumb url={p.thumbUrl} ratio="1 / 1" />
        <div className="prow-main">
          <div className="row-nowrap" style={{ gap: 8 }}>
            <span className="prow-title truncate">{p.title}</span>
          </div>
          {showProgress && active && lv ? (
            <div className="stack-s" style={{ gap: 5, marginTop: 4 }}>
              <ProgressBar value={lv.progress} label={`${p.title}: version ${lv.number} progress`} thin indeterminate={lv.progress == null || lv.status === 'queued'} />
              <div className="tiny muted">
                v{lv.number} · {VERSION_STATUS[lv.status].label}
                {lv.progress != null && lv.status !== 'queued' ? ` · ${Math.round(lv.progress * 100)}%` : ''}
              </div>
            </div>
          ) : (
            <div className="tiny muted truncate">
              {plural(p.versionCount, 'version')} · updated {relativeTime(p.updatedAt)}
            </div>
          )}
        </div>
        {!showProgress ? <StatusPill label={st.label} tone={st.tone} /> : null}
        <Icon name="chevron-right" className="faint" />
      </Link>
    </li>
  );
}
