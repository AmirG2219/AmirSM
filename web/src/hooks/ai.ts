import { useMemo } from 'react';
import { api } from '../api/client';
import { useAsync } from './hooks';

export interface AiAvailability {
  /** null = unknown (status could not be loaded); the server stays the source of truth. */
  configured: boolean | null;
  reason: string | null;
}

/** Whether the AI model is configured, with the server's own wording for why not. */
export function useAiAvailability(): AiAvailability {
  const st = useAsync((s) => api.settingsStatus(s), []);
  return useMemo(() => {
    const d = st.data;
    if (!d) return { configured: null, reason: null };
    const integ = d.integrations.find((i) => i.id === 'anthropic');
    return { configured: d.ai.configured, reason: d.ai.configured ? null : integ?.detail ?? 'No Anthropic API key is configured.' };
  }, [st.data]);
}
