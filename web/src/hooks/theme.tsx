import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { safeStorage } from './hooks';

type Theme = 'light' | 'dark';
const KEY = 'amirsm.theme';

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function initial(): Theme {
  const saved = safeStorage.get(KEY);
  return saved === 'light' || saved === 'dark' ? saved : systemTheme();
}

interface ThemeCtx {
  theme: Theme;
  toggle: () => void;
}
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [explicit, setExplicit] = useState(() => safeStorage.get(KEY) !== null);

  useEffect(() => {
    if (explicit) document.documentElement.setAttribute('data-theme', theme);
  }, [theme, explicit]);

  // Follow the OS until the owner picks a theme by hand.
  useEffect(() => {
    if (explicit) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [explicit]);

  const toggle = useCallback(() => {
    setTheme((t) => {
      const next: Theme = t === 'dark' ? 'light' : 'dark';
      safeStorage.set(KEY, next);
      return next;
    });
    setExplicit(true);
  }, []);

  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTheme outside ThemeProvider');
  return c;
}
