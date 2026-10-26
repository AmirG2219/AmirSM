import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  setData: (v: T | ((prev: T | undefined) => T | undefined)) => void;
}

/** Run an async loader when deps change. Stale responses are dropped; `reload()` refetches without clearing data. */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    loaderRef
      .current(ctl.signal)
      .then((v) => {
        if (ctl.signal.aborted) return;
        setData(v);
        setError(null);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (ctl.signal.aborted || e.name === 'AbortError') return;
        setError(e);
        setLoading(false);
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

/**
 * Call `fn` every `intervalMs` while `enabled`. Never overlaps itself, pauses while the tab is hidden,
 * and fires once immediately when the tab becomes visible again.
 */
export function usePolling(fn: () => Promise<unknown> | unknown, intervalMs: number, enabled: boolean) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    const schedule = () => {
      if (stopped) return;
      timer = window.setTimeout(run, intervalMs);
    };
    const run = async () => {
      if (stopped) return;
      if (document.hidden) {
        schedule();
        return;
      }
      try {
        await fnRef.current();
      } catch {
        /* the caller surfaces errors; keep polling */
      }
      schedule();
    };
    const onVisible = () => {
      if (!document.hidden && !stopped) {
        window.clearTimeout(timer);
        void run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs]);
}

/** localStorage that never throws. */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / blocked */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title ? `${title} · Amir SM` : 'Amir SM';
    return () => {
      document.title = prev;
    };
  }, [title]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}
