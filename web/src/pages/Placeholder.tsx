import { Link } from 'react-router-dom';
import { EmptyState, PageHeader } from '../components/ui';
import type { IconName } from '../components/Icon';
import { Button } from '../components/ui';
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
        <Link to="/studio" style={{ textDecoration: 'none' }}>
          <Button variant="quiet" icon="studio">
            Go to Social Studio
          </Button>
        </Link>
      </div>
    </div>
  );
}
