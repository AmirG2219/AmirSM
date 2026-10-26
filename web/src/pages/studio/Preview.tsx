import type { ProjectDetail, VersionDTO } from '@shared/api';
import { EmptyState } from '../../components/ui';
import type { AiAvailability } from '../../hooks/ai';
import { FailedView, ProgressView, ReadyView } from './ReviewView';

/** The right-hand pane: always shows the selected draft (progress, failure, or the finished video with caption and Approve & download). */
export function Preview({
  version, detail, poster, ai, anyActive, onChanged, onCreated,
}: {
  version: VersionDTO | null;
  detail: ProjectDetail;
  poster: string | null;
  ai: AiAvailability;
  anyActive: boolean;
  onChanged: () => Promise<void> | void;
  onCreated: (v: VersionDTO) => Promise<void> | void;
}) {
  if (!version) {
    return (
      <div className="pv-empty">
        <EmptyState icon="film" title="Your video will appear here" center>
          Tell the editor what you want in the chat. The first draft shows up in this pane, with its caption and an Approve and download button.
        </EmptyState>
      </div>
    );
  }
  if (isActive(version)) return <ProgressView version={version} onChanged={onChanged} />;
  if (version.status === 'failed' || version.status === 'cancelled') return <FailedView version={version} onChanged={onChanged} anyOtherActive={anyActive} />;
  if (version.output) {
    return (
      <ReadyView
        version={version}
        assets={detail.assets}
        posterUrl={poster}
        ai={ai}
        anyActive={anyActive}
        hideRevise
        onChanged={onChanged}
        onCreated={onCreated}
      />
    );
  }
  return null;
}

const isActive = (v: VersionDTO) => ['queued', 'planning', 'rendering', 'captioning'].includes(v.status);
