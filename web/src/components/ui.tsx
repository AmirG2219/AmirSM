import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './Icon';
import type { Tone } from '../lib/format';

const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/* ---------- Buttons ---------- */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'quiet' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  busy?: boolean;
  block?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, busy, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('btn', variant !== 'default' && `btn-${variant}`, size !== 'md' && `btn-${size}`, block && 'btn-block', className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 'sm' : undefined} /> : null}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: 'sm' | 'md';
  solid?: boolean;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', solid, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} aria-label={label} title={label} className={cx('icon-btn', size === 'sm' && 'icon-btn-sm', solid && 'icon-btn-solid', className)} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 'sm' : undefined} />
    </button>
  );
});

/* ---------- Surfaces ---------- */
export function Card({ className, children, as: Tag = 'div', ...rest }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'section' | 'article' | 'aside' }) {
  return (
    <Tag className={cx('card', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, subtitle, actions, icon, headingLevel = 2 }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: IconName; headingLevel?: 2 | 3 }) {
  const H = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <div className="card-head">
      {icon ? <Icon name={icon} className="faint" /> : null}
      <div style={{ minWidth: 0 }}>
        <H>{title}</H>
        {subtitle ? <div className="small muted">{subtitle}</div> : null}
      </div>
      <span className="spacer" />
      {actions}
    </div>
  );
}

/* ---------- Badges ---------- */
export function Badge({ tone = 'neutral', children, dot, spinner, outline, title }: { tone?: Tone; children: ReactNode; dot?: boolean; spinner?: boolean; outline?: boolean; title?: string }) {
  return (
    <span className={cx('badge', tone !== 'neutral' && `badge-${tone}`, outline && 'badge-outline')} title={title}>
      {spinner ? <span className="spinner" aria-hidden="true" /> : dot ? <span className="dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
export function StatusPill({ label, tone, active }: { label: string; tone: Tone; active?: boolean }) {
  return (
    <Badge tone={tone} dot={!active} spinner={active}>
      {label}
    </Badge>
  );
}

/* ---------- Form fields ---------- */
interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  optional?: boolean;
}
type WithIds = { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean };

function useFieldIds(hint: ReactNode, error: ReactNode, explicitId?: string) {
  const auto = useId();
  const id = explicitId ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return { id, hintId, errId, describedBy };
}

function FieldShell({ label, hint, error, className, optional, ids, children }: FieldShellProps & { ids: ReturnType<typeof useFieldIds>; children: ReactNode }) {
  return (
    <div className={cx('field', className)}>
      <label htmlFor={ids.id}>
        {label}
        {optional ? <span className="faint" style={{ fontWeight: 400 }}> · optional</span> : null}
      </label>
      {children}
      {hint ? (
        <div className="hint" id={ids.hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="error-text" id={ids.errId} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldShellProps>(function Input(
  { label, hint, error, className, optional, id: explicitId, ...rest },
  ref,
) {
  const ids = useFieldIds(hint, error, explicitId);
  const a11y: WithIds = { id: ids.id, 'aria-describedby': ids.describedBy, 'aria-invalid': error ? true : undefined };
  return (
    <FieldShell label={label} hint={hint} error={error} className={className} optional={optional} ids={ids}>
      <input ref={ref} className="input" {...a11y} {...rest} />
    </FieldShell>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & FieldShellProps>(function Textarea(
  { label, hint, error, className, optional, id: explicitId, ...rest },
  ref,
) {
  const ids = useFieldIds(hint, error, explicitId);
  const a11y: WithIds = { id: ids.id, 'aria-describedby': ids.describedBy, 'aria-invalid': error ? true : undefined };
  return (
    <FieldShell label={label} hint={hint} error={error} className={className} optional={optional} ids={ids}>
      <textarea ref={ref} className="textarea" {...a11y} {...rest} />
    </FieldShell>
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & FieldShellProps>(function Select(
  { label, hint, error, className, optional, id: explicitId, children, ...rest },
  ref,
) {
  const ids = useFieldIds(hint, error, explicitId);
  const a11y: WithIds = { id: ids.id, 'aria-describedby': ids.describedBy, 'aria-invalid': error ? true : undefined };
  return (
    <FieldShell label={label} hint={hint} error={error} className={className} optional={optional} ids={ids}>
      <select ref={ref} className="select" {...a11y} {...rest}>
        {children}
      </select>
    </FieldShell>
  );
});

/* ---------- Tabs (controlled, roving focus) ---------- */
export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  badge?: ReactNode;
}
export function Tabs<T extends string>({ items, value, onChange, label, idPrefix }: { items: TabItem<T>[]; value: T; onChange: (v: T) => void; label: string; idPrefix: string }) {
  const onKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === value);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n >= 0) {
      e.preventDefault();
      const t = items[n]!;
      onChange(t.id);
      requestAnimationFrame(() => document.getElementById(`${idPrefix}-tab-${t.id}`)?.focus());
    }
  };
  return (
    <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
      {items.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-tab-${t.id}`}
          role="tab"
          type="button"
          className="tab"
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
        >
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}

/* ---------- Feedback ---------- */
export function EmptyState({ icon = 'film', title, children, action, center, compact }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; center?: boolean; compact?: boolean }) {
  return (
    <div className={cx('empty', center && 'empty-center', compact && 'compact')}>
      {!compact ? (
        <div className="empty-mark">
          <Icon name={icon} />
        </div>
      ) : null}
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function ProgressBar({ value, label, indeterminate, thin }: { value?: number | null; label: string; indeterminate?: boolean; thin?: boolean }) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value)) * 100;
  const ind = indeterminate || pct == null;
  return (
    <div
      className={cx('progress', thin && 'progress-thin', ind && 'progress-indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={ind ? undefined : Math.round(pct!)}
    >
      <span style={{ width: ind ? undefined : `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ w, h = 14, style }: { w?: number | string; h?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" aria-hidden="true" style={{ width: w ?? '100%', height: h, ...style }} />;
}

export function Callout({ tone = 'info', title, children, icon }: { tone?: 'info' | 'warn' | 'err' | 'ok'; title?: ReactNode; children?: ReactNode; icon?: IconName }) {
  const def: IconName = tone === 'warn' || tone === 'err' ? 'alert' : tone === 'ok' ? 'circle-check' : 'info';
  return (
    <div className={`callout callout-${tone}`} role={tone === 'err' ? 'alert' : undefined}>
      <Icon name={icon ?? def} />
      <div>
        {title ? <div className="callout-title">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-label={label} style={{ display: 'inline-flex' }}>
      <span className="spinner" aria-hidden="true" />
    </span>
  );
}

export function PageHeader({ title, lede, actions }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {actions ? <div className="row">{actions}</div> : null}
    </header>
  );
}
