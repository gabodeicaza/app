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
  updateMe: (body: { name?: string; puesto?: string | null }) =>
    request<any>('PUT', '/auth/me', body),

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
  periodSummary: (period: 'daily' | 'weekly' | 'monthly', area?: string | null) =>
    request<{ summary: string }>('POST', '/ai/period-summary', { period, area: area ?? null }),

  // Activities (Noticias / FYP)
  listActivities: () => request<any[]>('GET', '/activities'),
  createActivity: (body: { title: string; description?: string; priority: 1 | 2 | 3; area?: string | null }) =>
    request<any>('POST', '/activities', body),
  deleteActivity: (id: string) => request<{ ok: boolean }>('DELETE', `/activities/${id}`),

  // Reference Points (Postes)
  listReferencePoints: () => request<any[]>('GET', '/reference-points'),
  createReferencePoint: (body: {
    name: string;
    location?: string | null;
    coordinates?: string | null;
    area?: string | null;
  }) => request<any>('POST', '/reference-points', body),
  updateReferencePoint: (
    id: string,
    body: {
      name: string;
      location?: string | null;
      coordinates?: string | null;
      area?: string | null;
    },
  ) => request<any>('PUT', `/reference-points/${id}`, body),
  deleteReferencePoint: (id: string) => request<{ ok: boolean }>('DELETE', `/reference-points/${id}`),

  // Chat (direct messaging)
  chatUsers: () => request<any[]>('GET', '/chat/users'),
  chatMessages: (peerId: string) => request<any[]>('GET', `/chat/messages/${peerId}`),
  chatSend: (toUser: string, text: string) =>
    request<any>('POST', '/chat/send', { to_user: toUser, text }),
  chatUnreadTotal: () => request<{ unread: number }>('GET', '/chat/unread-total'),

  // Site Config (Contract / Contractor)
  getSiteConfig: () =>
    request<{ contract: string; contractor: string; updatedAt?: string | null; updatedBy?: string | null }>(
      'GET',
      '/site-config',
    ),
  updateSiteConfig: (body: { contract?: string; contractor?: string }) =>
    request<{ contract: string; contractor: string; updatedAt?: string | null; updatedBy?: string | null }>(
      'PUT',
      '/site-config',
    body),

  // Smart report autocomplete history (per area)
  reportHistory: () =>
    request<{ personnel: string[]; equipment: string[]; activities: string[]; area?: string | null }>(
      'GET',
      '/report-history',
    ),
};

export { BASE };
