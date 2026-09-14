/** Lop goi API. Trinh duyet khong bao gio cham toi Runway key - moi thu qua server. */
import type { AssetKind, Catalog } from '@/lib/catalog';

export interface Me {
  name: string;
  role: 'admin' | 'member';
  hasKey: boolean;
}

export type JobState = 'QUEUED' | 'SUBMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** Runway tra cost duoi dang { credits: n }, khong phai so. */
export type Cost = { credits: number } | number | null;

export interface Job {
  jobId: string;
  taskId: string | null;
  state: JobState;
  path: string;
  model: string;
  title: string;
  promptText: string | null;
  user: string;
  queuePosition: number | null;
  progress: number | null;
  output: string[] | null;
  error: string | null;
  /** Ma loi ky thuat cua Runway - dich sang thong bao nguoi dung o lib/errors.ts */
  failureCode: string | null;
  /** Cau truc loi nguyen ban cua Runway, de doc ra tung truong sai. */
  errorDetails: unknown;
  /** File da duoc server tu luu. Dung cai nay thay link Runway da het han. */
  localOutput: string[] | null;
  estimatedCost: Cost;
  cost: Cost;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  payload?: Record<string, unknown>;
}

export interface ModelLimit {
  maxConcurrentGenerations: number;
  maxDailyGenerations: number;
}

export interface Organization {
  creditBalance: number;
  tier: { maxMonthlyCreditSpend: number; models: Record<string, ModelLimit> };
  usage: { models: Record<string, { dailyGenerations: number }> };
}

export interface User {
  name: string;
  role: 'admin' | 'member';
  code: string;
  /** Ma ngan hon nguong an toan - chi dung duoc trong mang noi bo. */
  weak?: boolean;
}

export const credits = (c: Cost): number | null =>
  c == null ? null : typeof c === 'object' ? c.credits : c;

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const type = res.headers.get('content-type') ?? '';
  const body: unknown = type.includes('json') ? await res.json() : await res.text();

  if (!res.ok) {
    const msg =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Lỗi ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

const post = <T>(path: string, data?: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

export const api = {
  me: () => request<Me>('/api/me'),
  login: (code: string) => post<{ name: string; role: string }>('/api/login', { code }),
  logout: () => post<{ ok: true }>('/api/logout'),

  catalog: () => request<Catalog>('/catalog.json'),
  organization: () => request<Organization>('/api/organization'),

  jobs: () => request<Job[]>('/api/jobs'),
  history: () => request<Job[]>('/api/history'),

  generate: (body: { path: string; payload: Record<string, unknown>; title: string }) =>
    post<Job>('/api/generate', body),

  cancel: (jobId: string) => request<{ ok: true }>(`/api/jobs/${jobId}`, { method: 'DELETE' }),

  removeHistory: (jobId: string) =>
    request<{ ok: true }>(`/api/history/${jobId}`, { method: 'DELETE' }),

  save: (body: { url: string; jobId: string; index: number }) =>
    post<{ ok: true; file: string; localUrl: string }>('/api/save', body),

  users: () => request<User[]>('/api/users'),
  addUser: (name: string, role: 'admin' | 'member') => post<User>('/api/users', { name, role }),
  removeUser: (name: string) =>
    request<{ ok: true }>(`/api/users/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  rotateUser: (name: string) => post<User>(`/api/users/${encodeURIComponent(name)}/rotate`),

  /** Gui raw bytes; ten file ma hoa o header vi co the chua dau tieng Viet. */
  async upload(file: File): Promise<{ uri: string; filename: string }> {
    const res = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'X-Filename': encodeURIComponent(file.name),
        'X-Content-Type': file.type || 'application/octet-stream',
      },
      body: file,
    });
    const body = (await res.json()) as { uri?: string; filename?: string; error?: string };
    if (!res.ok) throw new ApiError(body.error ?? 'Tải lên thất bại', res.status, body);
    return { uri: body.uri!, filename: body.filename! };
  },
};

/** Doan loai asset tu MIME type cua file nguoi dung tha vao. */
export function kindOfFile(file: File): AssetKind {
  const t = file.type;
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Doan loai media tu duoi file trong URL ket qua. */
export function kindOfUrl(url: string): AssetKind {
  if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return 'video';
  if (/\.(mp3|wav|m4a|ogg|flac)(\?|$)/i.test(url)) return 'audio';
  return 'image';
}
