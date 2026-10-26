import type { ReactNode } from 'react';
import { hostOf, safeHttpUrl } from '../lib/url';
import { Icon } from './Icon';

/** Link to an external page. Only http(s) URLs render as links; anything else is shown as plain text. */
export function ExternalLink({ url, children }: { url: string | null | undefined; children?: ReactNode }) {
  const safe = safeHttpUrl(url);
  if (!safe) return url ? <span className="muted" title="Not a web link, so it is not clickable">{children ?? url}</span> : null;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer" className="ext-link">
      {children ?? hostOf(safe)}
      <Icon name="external" size="sm" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
