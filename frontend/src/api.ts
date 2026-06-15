// SynCo v2.0 REST client.
// Reads JWT from secure storage on every call.
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

async function request<T>(method: string, path: string, body?: any): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(await authHeader()),
  };
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const msg = (data && (data as any).detail) || `HTTP ${res.status}`;
    throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data as T;
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

// ---- Types (subset for hints) ---------------------------------------------
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'coordinador_general' | 'sub_coordinador' | 'especialista';
  area?: string | null;
  puesto?: string | null;
  scope_node_id?: string | null;
  scope_node_ids: string[];
  project_ids: string[];
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  constructora: string;
  contract_number: string;
  start_date?: string | null;
  end_date?: string | null;
  description?: string | null;
  created_by: string;
  created_at: string;
  archived?: boolean;
}

export interface LocationNode {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  order: number;
  is_leaf: boolean;
  measurement_type: 'coord_latlon' | 'cadenamiento' | 'eje' | 'nivel' | null;
}

export interface LocationNodeTree extends LocationNode {
  children: LocationNodeTree[];
}

export interface Area {
  id: string;
  project_id: string;
  name: string;
  color: string;
}

export interface Invitation {
  id: string;
  token: string;
  project_id: string;
  project_name: string;
  email: string;
  name: string;
  role: 'sub_coordinador' | 'especialista';
  area_id?: string | null;
  puesto?: string | null;
  scope_node_id?: string | null;
  scope_node_ids: string[];
  status: 'pending' | 'accepted' | 'revoked';
  created_at: string;
  expires_at: string;
}

export interface Report {
  id: string;
  project_id: string;
  node_id: string;
  node_path_names: string[];
  measurement_type: string;
  measurement_value: Record<string, any>;
  area_id?: string | null;
  area_name?: string | null;
  notes?: string | null;
  avance?: string | null;
  contratista?: string | null;
  personnel: string[];
  equipment: string[];
  images: string[];
  files: Array<{ filename: string; mime: string; data_base64: string }>;
  captured_by: string;
  captured_by_name: string;
  created_at: string;
}

// ---- API client -----------------------------------------------------------
export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  me: () => request<User>('GET', '/auth/me'),

  // Invitations
  invitePreview: (token: string) =>
    request<{ project_name: string; email: string; name: string; role: string; puesto?: string | null; area_name?: string | null }>(
      'GET', `/invitations/by-token/${encodeURIComponent(token)}`,
    ),
  acceptInvite: (token: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/invitations/accept', { token, password }),

  // Projects
  listProjects: () => request<Project[]>('GET', '/projects'),
  getProject: (pid: string) => request<Project>('GET', `/projects/${pid}`),
  createProject: (body: {
    name: string;
    constructora: string;
    contract_number: string;
    start_date?: string | null;
    end_date?: string | null;
    description?: string | null;
  }) => request<Project>('POST', '/projects', body),
  updateProject: (pid: string, body: any) => request<Project>('PUT', `/projects/${pid}`, body),
  archiveProject: (pid: string) => request<{ ok: boolean; archived: boolean }>('DELETE', `/projects/${pid}`),

  // Nodes
  listNodes: (pid: string) => request<LocationNode[]>('GET', `/projects/${pid}/nodes`),
  getTree: (pid: string) => request<LocationNodeTree[]>('GET', `/projects/${pid}/nodes/tree`),
  createNode: (pid: string, body: {
    project_id: string;
    parent_id?: string | null;
    name: string;
    order?: number;
    is_leaf?: boolean;
    measurement_type?: 'coord_latlon' | 'cadenamiento' | 'eje' | 'nivel' | null;
  }) => request<LocationNode>('POST', `/projects/${pid}/nodes`, body),
  updateNode: (nid: string, body: {
    name?: string;
    order?: number;
    is_leaf?: boolean;
    measurement_type?: 'coord_latlon' | 'cadenamiento' | 'eje' | 'nivel' | null;
  }) => request<LocationNode>('PATCH', `/nodes/${nid}`, body),
  deleteNode: (nid: string) => request<{ ok: boolean; deleted_count: number }>('DELETE', `/nodes/${nid}`),

  // Areas
  listAreas: (pid: string) => request<Area[]>('GET', `/projects/${pid}/areas`),
  createArea: (pid: string, body: { project_id: string; name: string; color?: string }) =>
    request<Area>('POST', `/projects/${pid}/areas`, body),
  deleteArea: (aid: string) => request<{ ok: boolean }>('DELETE', `/areas/${aid}`),

  // Invitations (admin)
  listInvitations: (pid: string) => request<Invitation[]>('GET', `/projects/${pid}/invitations`),
  createInvitation: (pid: string, body: {
    project_id: string;
    email: string;
    name: string;
    role: 'sub_coordinador' | 'especialista';
    scope_node_id?: string | null;
    area_id?: string | null;
    puesto?: string | null;
    scope_node_ids?: string[];
  }) => request<Invitation>('POST', `/projects/${pid}/invitations`, body),
  revokeInvitation: (iid: string) => request<{ ok: boolean }>('DELETE', `/invitations/${iid}`),

  // Reports
  createReport: (body: {
    project_id: string;
    node_id: string;
    measurement_value: Record<string, any>;
    area_id?: string | null;
    notes?: string | null;
    avance?: string | null;
    contratista?: string | null;
    personnel?: string[];
    equipment?: string[];
    images?: string[];
    files?: Array<{ filename: string; mime: string; data_base64: string }>;
  }) => request<Report>('POST', '/reports', body),
  listReports: (pid: string) => request<Report[]>('GET', `/projects/${pid}/reports`),
  getReport: (rid: string) => request<Report>('GET', `/reports/${rid}`),
  deleteReport: (rid: string) => request<{ ok: boolean }>('DELETE', `/reports/${rid}`),

  // Users (admin)
  listProjectUsers: (pid: string) => request<User[]>('GET', `/projects/${pid}/users`),
};

export { BASE };
