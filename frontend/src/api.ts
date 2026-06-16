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
  // Coordenadas objetivo (sólo cuando es hoja con measurement_type = 'coord_latlon')
  target_lat?: number | null;
  target_lon?: number | null;
  target_elev?: number | null;
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

export interface FeedItem {
  id: string;
  project_id: string;
  node_id: string;
  node_path_names: string[];
  measurement_type: string;
  measurement_value: Record<string, any>;
  area_id?: string | null;
  area_name?: string | null;
  area_color?: string | null;
  avance?: string | null;
  contratista?: string | null;
  personnel: string[];
  equipment: string[];
  captured_by: string;
  captured_by_name: string;
  is_mine: boolean;
  images_count: number;
  thumbnail_base64?: string | null;
  created_at: string;
}

export interface FeedResponse {
  range: string;
  stats: { total: number; mine: number; others: number };
  reports: FeedItem[];
}

export interface Announcement {
  id: string;
  project_id: string;
  title: string;
  body: string;
  pinned: boolean;
  author_id: string;
  author_name: string;
  author_role?: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  project_id: string;
  channel_id?: string;
  user_id: string;
  user_name: string;
  user_role: string;
  user_area?: string | null;
  text: string;
  created_at: string;
}

export interface ChannelPeer {
  id: string;
  name: string;
  role: string;
}

export interface Channel {
  id: string;
  project_id: string;
  type: 'general' | 'area' | 'direct';
  name: string;
  area_id?: string | null;
  color?: string | null;
  member_ids?: string[] | null;
  peer?: ChannelPeer | null;
  last_message?: {
    id?: string;
    text?: string | null;
    user_id?: string;
    user_name?: string;
    created_at?: string;
  } | null;
  created_at: string;
}

export interface ProjectEvent {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  start_at: string;
  end_at?: string | null;
  author_id: string;
  author_name: string;
  author_role?: string;
  created_at: string;
  updated_at: string;
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
    target_lat?: number | null;
    target_lon?: number | null;
    target_elev?: number | null;
  }) => request<LocationNode>('POST', `/projects/${pid}/nodes`, body),
  updateNode: (nid: string, body: {
    name?: string;
    order?: number;
    is_leaf?: boolean;
    measurement_type?: 'coord_latlon' | 'cadenamiento' | 'eje' | 'nivel' | null;
    target_lat?: number | null;
    target_lon?: number | null;
    target_elev?: number | null;
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
  feed: (pid: string, range: 'today' | 'week' | 'month' | 'all' = 'today', limit = 50) =>
    request<FeedResponse>('GET', `/projects/${pid}/reports/feed?range=${range}&limit=${limit}`),
  getReport: (rid: string) => request<Report>('GET', `/reports/${rid}`),

  // ---- Announcements (Noticias) -------------------------------------------
  listAnnouncements: (pid: string) =>
    request<Announcement[]>('GET', `/projects/${pid}/announcements`),
  createAnnouncement: (pid: string, payload: { title: string; body: string; pinned?: boolean }) =>
    request<Announcement>('POST', `/projects/${pid}/announcements`, payload),
  updateAnnouncement: (aid: string, payload: { title?: string; body?: string; pinned?: boolean }) =>
    request<Announcement>('PATCH', `/announcements/${aid}`, payload),
  deleteAnnouncement: (aid: string) =>
    request<{ ok: boolean }>('DELETE', `/announcements/${aid}`),

  // ---- Messages (chat) ----------------------------------------------------
  listMessages: (pid: string, params: { since?: string; before?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.since) qs.set('since', params.since);
    if (params.before) qs.set('before', params.before);
    qs.set('limit', String(params.limit ?? 100));
    return request<Message[]>('GET', `/projects/${pid}/messages?${qs.toString()}`);
  },
  sendMessage: (pid: string, text: string) =>
    request<Message>('POST', `/projects/${pid}/messages`, { text }),
  deleteMessage: (mid: string) =>
    request<{ ok: boolean }>('DELETE', `/messages/${mid}`),

  // ---- Channels (canales: General / Áreas / Directos) --------------------
  listChannels: (pid: string) =>
    request<Channel[]>('GET', `/projects/${pid}/channels`),
  getChannel: (cid: string) =>
    request<Channel>('GET', `/channels/${cid}`),
  listChannelMessages: (cid: string, params: { since?: string; before?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.since) qs.set('since', params.since);
    if (params.before) qs.set('before', params.before);
    qs.set('limit', String(params.limit ?? 100));
    return request<Message[]>('GET', `/channels/${cid}/messages?${qs.toString()}`);
  },
  sendChannelMessage: (cid: string, text: string) =>
    request<Message>('POST', `/channels/${cid}/messages`, { text }),
  createDirectChannel: (pid: string, target_user_id: string) =>
    request<Channel>('POST', `/projects/${pid}/channels/direct`, { target_user_id }),
  listProjectMembers: (pid: string) =>
    request<User[]>('GET', `/projects/${pid}/members`),

  // ---- Events (Calendario) ------------------------------------------------
  listEvents: (pid: string, range: 'upcoming' | 'past' | 'all' = 'upcoming', limit = 500) =>
    request<ProjectEvent[]>('GET', `/projects/${pid}/events?range=${range}&limit=${limit}`),
  createEvent: (pid: string, payload: {
    title: string; start_at: string; end_at?: string | null;
    description?: string | null; location?: string | null;
  }) => request<ProjectEvent>('POST', `/projects/${pid}/events`, payload),
  updateEvent: (eid: string, payload: Partial<{
    title: string; start_at: string; end_at: string | null;
    description: string | null; location: string | null;
  }>) => request<ProjectEvent>('PATCH', `/events/${eid}`, payload),
  deleteEvent: (eid: string) =>
    request<{ ok: boolean }>('DELETE', `/events/${eid}`),
  deleteReport: (rid: string) => request<{ ok: boolean }>('DELETE', `/reports/${rid}`),

  // Users (admin)
  listProjectUsers: (pid: string) => request<User[]>('GET', `/projects/${pid}/users`),
};

export { BASE };
