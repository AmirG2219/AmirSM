import { EmptyState, LinkButton, PageHeader } from '../components/ui';
import type { IconName } from '../components/Icon';
import { useDocumentTitle } from '../hooks/hooks';

export function Placeholder({ title, icon, lede, children }: { title: string; icon: IconName; lede: string; children: string }) {
  useDocumentTitle(title);
  return (
    <div className="page page-narrow">
      <PageHeader title={title} lede={lede} />
      <EmptyState icon={icon} title="Coming in phase 2">
        {children}
      </EmptyState>
      <div style={{ marginTop: 'var(--s-4)' }}>
        <LinkButton to="/studio" variant="quiet" icon="studio">
          Go to Social Studio
        </LinkButton>
      </div>
    </div>
  );
}
