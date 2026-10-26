import type {
  AssetDTO,
  AuthState,
  ChatMessageDTO,
  ChatResponse,
  EmailAccountDTO,
  EmailConnectInput,
  EmailConnectionTestResult,
  EmailProviderPreset,
  EmailDraftDTO,
  EmailThreadDetail,
  EmailThreadSummary,
  ProjectDetail,
  ProjectSummary,
  SettingsStatus,
  UploadResult,
  VersionDTO,
} from '@shared/api';
import type { OutputFormat, StylePreset } from '@shared/editPlan';
import type { Caption } from '@shared/domain';

/** Fired when any request comes back 401 `unauthenticated` so the auth gate can show the sign-in screen. */
export const UNAUTH_EVENT = 'amirsm:unauthenticated';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function notifyUnauthenticated() {
  window.dispatchEvent(new Event(UNAUTH_EVENT));
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  if (err?.code) return new ApiError(res.status, err.code, err.message ?? res.statusText, err.details);
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return new ApiError(res.status, 'server_unreachable', 'The Amir SM server is not responding. Check that it is running, then try again.');
  }
  return new ApiError(res.status, 'http_error', `Request failed (${res.status} ${res.statusText}).`);
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Could not reach the Amir SM server. Check that it is running, then try again.');
  }
  if (!res.ok) {
    const err = await toApiError(res);
    if (res.status === 401 && err.code === 'unauthenticated') notifyUnauthenticated();
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>('GET', path, undefined, signal);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);

export type UploadItemResult = UploadResult['results'][number];

/**
 * Upload ONE file with real byte progress (XMLHttpRequest — fetch cannot report upload progress).
 * One request per file keeps progress and errors per-file.
 */
export function uploadFile(
  projectId: string,
  file: File,
  onProgress: (fraction: number) => void,
  role: 'footage' | 'reference' = 'footage',
): { promise: Promise<UploadItemResult>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadItemResult>((resolve, reject) => {
    xhr.open('POST', `/api/projects/${encodeURIComponent(projectId)}/assets${role === 'reference' ? '?role=reference' : ''}`);
    xhr.withCredentials = true;
    xhr.responseType = 'json';
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The upload was interrupted. Check your connection and the server, then try again.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload cancelled.'));
    xhr.onload = () => {
      const body = xhr.response as (UploadResult & { error?: { code: string; message: string; details?: unknown } }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.results) {
        const r = body.results[0];
        resolve(r ?? { name: file.name, ok: false, error: 'The server returned no result for this file.' });
        return;
      }
      if (xhr.status === 401) notifyUnauthenticated();
      if (body?.error) reject(new ApiError(xhr.status, body.error.code, body.error.message, body.error.details));
      else if (xhr.status === 502 || xhr.status === 503 || xhr.status === 504) reject(new ApiError(xhr.status, 'server_unreachable', 'The Amir SM server is not responding.'));
      else reject(new ApiError(xhr.status, 'http_error', `Upload failed (${xhr.status}).`));
    };
    const fd = new FormData();
    fd.append('files', file, file.name);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export interface ProjectListParams {
  status?: string;
  q?: string;
  includeArchived?: boolean;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface DraftInput {
  accountId: string;
  threadId?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  aiAssisted?: boolean;
}

export const api = {
  auth: {
    state: (signal?: AbortSignal) => get<AuthState>('/api/auth/state', signal),
    setup: (password: string) => post<{ ok: true }>('/api/auth/setup', { password }),
    login: (password: string) => post<{ ok: true }>('/api/auth/login', { password }),
    logout: () => post<{ ok: true }>('/api/auth/logout'),
  },
  settingsStatus: (signal?: AbortSignal) => get<SettingsStatus>('/api/settings/status', signal),
  projects: {
    list: (p: ProjectListParams = {}, signal?: AbortSignal) => {
      const q = qs({ status: p.status, q: p.q, includeArchived: p.includeArchived ? 'true' : undefined });
      return get<ProjectSummary[]>(`/api/projects${q}`, signal);
    },
    create: (b: { title: string; brief?: string; stylePreset?: StylePreset; format?: OutputFormat }) => post<ProjectDetail>('/api/projects', b),
    get: (id: string, signal?: AbortSignal) => get<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, signal),
    patch: (id: string, b: { title?: string; brief?: string; stylePreset?: StylePreset; format?: OutputFormat; subtitleLines?: string[] }) =>
      patch<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}`, b),
    archive: (id: string) => post<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}/archive`),
    unarchive: (id: string) => post<ProjectDetail>(`/api/projects/${encodeURIComponent(id)}/unarchive`),
  },
  assets: {
    patch: (id: string, b: { excluded?: boolean; sortOrder?: number }) => patch<AssetDTO>(`/api/assets/${encodeURIComponent(id)}`, b),
  },
  chat: {
    list: (projectId: string, signal?: AbortSignal) => get<ChatMessageDTO[]>(`/api/projects/${encodeURIComponent(projectId)}/chat`, signal),
    send: (projectId: string, text: string, attachmentIds: string[]) => post<ChatResponse>(`/api/projects/${encodeURIComponent(projectId)}/chat`, { text, attachmentIds }),
  },
  versions: {
    create: (projectId: string, b: { instruction?: string; baseVersionId?: string }) => post<VersionDTO>(`/api/projects/${encodeURIComponent(projectId)}/versions`, b),
    get: (id: string, signal?: AbortSignal) => get<VersionDTO>(`/api/versions/${encodeURIComponent(id)}`, signal),
    cancel: (id: string) => post<VersionDTO>(`/api/versions/${encodeURIComponent(id)}/cancel`),
    retry: (id: string, replan: boolean) => post<VersionDTO>(`/api/versions/${encodeURIComponent(id)}/retry`, { replan }),
    patchCaption: (id: string, c: Caption) => patch<VersionDTO>(`/api/versions/${encodeURIComponent(id)}/caption`, c),
    regenerateCaption: (id: string, feedback?: string) => post<VersionDTO>(`/api/versions/${encodeURIComponent(id)}/caption/regenerate`, feedback ? { feedback } : {}),
    approve: (id: string) => post<VersionDTO>(`/api/versions/${encodeURIComponent(id)}/approve`),
    captionUrl: (id: string, download = false) => `/api/versions/${encodeURIComponent(id)}/caption.txt${download ? '?download=1' : ''}`,
  },
  email: {
    accounts: (signal?: AbortSignal) => get<EmailAccountDTO[]>('/api/email/accounts', signal),
    providers: (signal?: AbortSignal) => get<EmailProviderPreset[]>('/api/email/providers', signal),
    testConnection: (b: EmailConnectInput) => post<EmailConnectionTestResult>('/api/email/accounts/test', b),
    connect: (b: EmailConnectInput) => post<EmailAccountDTO>('/api/email/accounts', b),
    disconnect: (id: string) => request<{ ok: true }>('DELETE', `/api/email/accounts/${encodeURIComponent(id)}`),
    sync: (id: string, wait = false) => post<EmailAccountDTO>(`/api/email/accounts/${encodeURIComponent(id)}/sync`, wait ? { wait: true } : {}),
    threads: (p: { accountId?: string; q?: string; filter?: string; mailbox?: 'inbox' | 'sent' | 'all'; serverSearch?: boolean; limit?: number }, signal?: AbortSignal) =>
      get<EmailThreadSummary[]>(`/api/email/threads${qs({ accountId: p.accountId, q: p.q, filter: p.filter, mailbox: p.mailbox, serverSearch: p.serverSearch ? 'true' : undefined, limit: p.limit ? String(p.limit) : undefined })}`, signal),
    thread: (id: string, signal?: AbortSignal) => get<EmailThreadDetail>(`/api/email/threads/${encodeURIComponent(id)}`, signal),
    markRead: (id: string, read: boolean) => post<EmailThreadDetail>(`/api/email/threads/${encodeURIComponent(id)}/read`, { read }),
    summarize: (id: string) => post<EmailThreadDetail>(`/api/email/threads/${encodeURIComponent(id)}/summarize`),
    aiDraft: (b: { instruction: string; threadId?: string; tone?: string }) => post<{ subject: string; body: string }>('/api/email/ai/draft', b),
    aiTone: (b: { text: string; tone: string }) => post<{ text: string }>('/api/email/ai/tone', b),
    drafts: (signal?: AbortSignal) => get<EmailDraftDTO[]>('/api/email/drafts', signal),
    createDraft: (b: DraftInput) => post<EmailDraftDTO>('/api/email/drafts', b),
    updateDraft: (id: string, b: Partial<Pick<DraftInput, 'to' | 'cc' | 'subject' | 'body' | 'aiAssisted'>>) => patch<EmailDraftDTO>(`/api/email/drafts/${encodeURIComponent(id)}`, b),
    approve: (id: string) => post<EmailDraftDTO>(`/api/email/drafts/${encodeURIComponent(id)}/approve`),
    send: (id: string) => post<EmailDraftDTO>(`/api/email/drafts/${encodeURIComponent(id)}/send`),
  },
};
