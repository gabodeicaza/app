// Thin REST client. Reads token from secure storage on every call.
import { storage } from '@/src/utils/storage';

const BASE = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '') + '/api';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const tok = await storage.secureGet<string>('syncsite_token', '');
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

async function request<T>(
  method: string,
  path: string,
  body?: any,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await authHeader()),
  };
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = data?.detail || `HTTP ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: any }>('POST', '/auth/login', { email, password }),
  register: (body: any) =>
    request<{ token: string; user: any }>('POST', '/auth/register', body),
  me: () => request<any>('GET', '/auth/me'),

  // Areas
  listAreas: () => request<any[]>('GET', '/areas'),
  createArea: (name: string, color?: string, icon?: string) =>
    request<any>('POST', '/areas', { name, color, icon }),
  deleteArea: (id: string) => request<{ ok: boolean }>('DELETE', `/areas/${id}`),

  // Reports
  createReport: (body: any) => request<any>('POST', '/reports', body),
  listReports: () => request<any[]>('GET', '/reports'),
  reportsToday: () => request<{ reports: any[]; stats: any; total: number }>('GET', '/reports/today'),

  // AI
  improveText: (title: string, comments: string, area: string) =>
    request<{ text: string }>('POST', '/ai/improve-text', { title, comments, area }),
  dailySummary: (reports: any[]) =>
    request<{ summary: string }>('POST', '/ai/daily-summary', { reports }),
};

export { BASE };
