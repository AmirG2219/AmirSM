import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, UNAUTH_EVENT } from '../api/client';

export type AuthStatus = 'loading' | 'setup' | 'login' | 'authed' | 'error';

interface AuthCtx {
  status: AuthStatus;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.auth.state();
      setError(null);
      setStatus(s.authenticated ? 'authed' : s.setupRequired ? 'setup' : 'login');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any API call that comes back 401 drops us to the sign-in screen without a full reload.
  useEffect(() => {
    const on = () => setStatus((s) => (s === 'authed' ? 'login' : s));
    window.addEventListener(UNAUTH_EVENT, on);
    return () => window.removeEventListener(UNAUTH_EVENT, on);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      setStatus('login');
    }
  }, []);

  const value = useMemo(() => ({ status, error, refresh, logout }), [status, error, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
