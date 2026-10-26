import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { ApiError } from '../api/client';

type ToastTone = 'ok' | 'err' | 'warn' | 'info';
interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}
interface ToastApi {
  push: (t: { tone?: ToastTone; title: string; message?: string; ms?: number }) => void;
  success: (title: string, message?: string) => void;
  /** Turn any thrown error into a specific, honest toast. */
  error: (e: unknown, fallbackTitle?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
const ICON: Record<ToastTone, IconName> = { ok: 'circle-check', err: 'circle-x', warn: 'alert', info: 'info' };

/** Map an API error to a toast headline that says what kind of problem it is. */
export function describeError(e: unknown, fallbackTitle = 'Something went wrong'): { tone: ToastTone; title: string; message: string } {
  if (e instanceof ApiError) {
    if (e.status === 409) return { tone: 'warn', title: e.code === 'ai_unavailable' ? 'AI is not available' : e.code === 'busy' ? 'Already in progress' : 'Not possible right now', message: e.message };
    if (e.status === 429) return { tone: 'warn', title: 'Too many attempts', message: e.message };
    if (e.status === 502) return { tone: 'err', title: e.code === 'caption_failed' ? 'Caption could not be generated' : 'Upstream service failed', message: e.message };
    if (e.status === 413) return { tone: 'err', title: 'File too large', message: e.message };
    if (e.status === 400) return { tone: 'warn', title: 'Check your input', message: e.message };
    if (e.status === 0 || e.code === 'server_unreachable') return { tone: 'err', title: 'Server not reachable', message: e.message };
    return { tone: 'err', title: fallbackTitle, message: e.message };
  }
  return { tone: 'err', title: fallbackTitle, message: e instanceof Error ? e.message : String(e) };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback<ToastApi['push']>(
    ({ tone = 'info', title, message, ms }) => {
      const id = next.current++;
      setItems((l) => [...l.slice(-3), { id, tone, title, message }]);
      window.setTimeout(() => dismiss(id), ms ?? (tone === 'err' || tone === 'warn' ? 9000 : 4500));
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, message) => push({ tone: 'ok', title, message }),
      error: (e, fallbackTitle) => {
        const d = describeError(e, fallbackTitle);
        push({ tone: d.tone, title: d.title, message: d.message });
      },
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={ICON[t.tone]} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="toast-title">{t.title}</div>
              {t.message ? <div className="toast-msg">{t.message}</div> : null}
            </div>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <Icon name="x" size="sm" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast outside ToastProvider');
  return c;
}
