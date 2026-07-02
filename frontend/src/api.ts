// SynCo v2.0 REST client.
// Reads JWT from secure storage on every call.
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
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

/**
 * Normaliza el objeto que va a `FormData.append` en React Native (Android/iOS)
 * para evitar el bug "Network Request Failed" al enviar multipart/form-data.
 *
 * Problema: `expo-document-picker` y `expo-image-picker` devuelven URIs de
 * varios esquemas (`content://`, `ph://`, `assets-library://`, ruta absoluta
 * sin `file://`) que `fetch`/`FormData` de React Native no sabe resolver como
 * archivo binario y provoca `Network Request Failed` al enviar.
 *
 * Solución (Android): copiamos la URI original al `cacheDirectory` con
 * `expo-file-system` para materializar un `file://…` estable. En iOS también
 * normalizamos `ph://` y `assets-library://` por seguridad.
 *
 * El objeto retornado incluye ESTRICTAMENTE las tres llaves requeridas por
 * el runtime de RN: `{ uri, name, type }`.
 */
async function normalizeFileForFormData(
  file: { uri: string; name?: string | null; mimeType?: string | null },
  fallbackName: string,
  fallbackMime: string,
  cachePrefix: string = 'upload',
): Promise<{ uri: string; name: string; type: string }> {
  const rawName = (file.name && file.name.trim()) || fallbackName;
  const safeName = rawName.replace(/[^A-Za-z0-9._-]/g, '_') || fallbackName;
  const type = (file.mimeType && file.mimeType.trim()) || fallbackMime;
  let uri = file.uri || '';

  // ¿Necesitamos copiar la URI a un file:// del cache?
  const needsCopy =
    Platform.OS === 'android'
      ? // Android: cualquier cosa que NO sea file:// (content://, ph://,
        // /storage/..., asset://) debe materializarse para poder subirse.
        !uri.startsWith('file://')
      : // iOS: los picker suelen devolver file:// tras copyToCacheDirectory,
        // pero ph:// y assets-library:// también deben materializarse.
        uri.startsWith('ph://') || uri.startsWith('assets-library://');

  if (needsCopy) {
    try {
      const dest = `${FileSystem.cacheDirectory}${cachePrefix}_${Date.now()}_${safeName}`;
      await FileSystem.copyAsync({ from: uri, to: dest });
      uri = dest;
    } catch {
      // Si la copia falla, seguimos con la URI original y aplicamos el fallback
      // de prefijo file:// más abajo. Ante content:// no habrá modo de subirlo,
      // pero el error de red que devolverá el fetch será claro para el usuario.
    }
  }

  // Refuerzo defensivo Android: cualquier ruta absoluta que llegue sin esquema
  // debe llevar file:// para que RN la interprete correctamente.
  if (Platform.OS === 'android' && uri.startsWith('/')) {
    uri = 'file://' + uri;
  }

  return { uri, name: safeName, type };
}

// ---- Types (subset for hints) ---------------------------------------------
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'coordinador_general' | 'jefe_proyecto' | 'sub_coordinador' | 'especialista';
  area?: string | null;
  puesto?: string | null;
  scope_node_id?: string | null;
  scope_node_ids: string[];
  project_ids: string[];
  expo_push_tokens?: string[];
  created_at: string;
}

export interface ReferenceFile {
  name: string;
  url: string;
  /** Identificador único para descargar/borrar (sólo presente en archivos subidos). */
  file_id?: string;
  original_name?: string;
  mime_type?: string;
  size?: number;
  uploaded_by?: string;
  uploaded_by_name?: string;
  uploaded_at?: string;
}

export interface Project {
  id: string;
  name: string;
  constructora: string;
  contract_number: string;
  objeto_contrato?: string | null;
  cliente_principal?: string | null;
  color_tema?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  description?: string | null;
  reference_files?: ReferenceFile[];
  contratistas_list?: string[];
  contratos_list?: string[];
  categorias_personal?: string[];
  categorias_equipo?: string[];
  // Rutas absolutas backend a plantillas base institucionales (null si no hay)
  template_pdf?: string | null;
  template_docx?: string | null;
  template_pptx?: string | null;
  template_map?: string | null;
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
  // Meta/objetivo numérico para gráficas circulares de avance.
  meta?: number | null;
  // Avance acumulado persistido (MAX ultima_lectura). Inyectado por backend.
  avance_actual?: number | null;
  // Metadatos dinámicos (importación masiva Excel/CSV). Llaves arbitrarias.
  metadata?: Record<string, any> | null;
  // Portada institucional del nodo (data URL base64). Se usa como fondo de la
  // portadilla dinámica del PDF exportado.
  cover_image?: string | null;
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
  node_path_ids?: string[];
  measurement_type: string;
  measurement_value: Record<string, any>;
  area_id?: string | null;
  area_name?: string | null;
  notes?: string | null;
  avance?: string | null;
  observaciones?: string | null;
  incidencias?: string | null;
  severidad?: 'informativo' | 'importante' | 'urgente';
  contratista?: string | null;
  personnel: string[];
  equipment: string[];
  images: string[];
  files: { filename: string; mime: string; data_base64: string }[];
  primera_lectura?: number | null;
  ultima_lectura?: number | null;
  unidad?: string | null;
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
  // Optional report-detail fields surfaced by the feed/list endpoints.
  notes?: string | null;
  observaciones?: string | null;
  actividades?: string | null;
  comment?: string | null;
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
  jerarquia?: 'urgente' | 'importante' | 'informativo' | null;
  audiencia?: string | null;
  node_id?: string | null;
  node_name?: string | null;
  node_path_ids?: string[];
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
  // Disciplina/área asociada (universal: refleja la jerarquía de colores)
  area_id?: string | null;
  area_name?: string | null;
  area_color?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DailyGoal {
  id: string;
  project_id: string;
  text: string;
  is_completed: boolean;
  created_at: string;
  created_by: string;
  created_by_name?: string;
}

// ---- API client -----------------------------------------------------------
export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  me: () => request<User>('GET', '/auth/me'),

  // Admin — Coordinadores Generales (sólo accesible por coord_general)
  listCoordinators: () => request<User[]>('GET', '/admin/coordinators'),
  createCoordinator: (body: { name: string; email: string; password: string }) =>
    request<User>('POST', '/admin/coordinators', body),

  // Mensajes — conteo de no leídos por proyecto.
  unreadCounts: () => request<Record<string, number>>('GET', '/messages/unread_counts'),
  markProjectMessagesSeen: (pid: string) =>
    request<{ ok: boolean; last_read_at: string }>('POST', `/projects/${pid}/messages/seen`, {}),

  // Push notifications
  registerPushToken: (token: string, platform?: string) =>
    request<{ ok: boolean; count: number }>('POST', '/users/push-token', { token, platform }),
  unregisterPushToken: (token: string) =>
    request<{ ok: boolean }>('DELETE', '/users/push-token', { token }),

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
    objeto_contrato?: string | null;
    cliente_principal?: string | null;
    color_tema?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    description?: string | null;
  }) => request<Project>('POST', '/projects', body),
  updateProject: (pid: string, body: any) => request<Project>('PUT', `/projects/${pid}`, body),
  setProjectReferenceFiles: (pid: string, files: ReferenceFile[]) =>
    request<{ ok: boolean; reference_files: ReferenceFile[] }>(
      'PUT', `/projects/${pid}/reference-files`, { reference_files: files }
    ),
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
    meta?: number | null;
  }) => request<LocationNode>('POST', `/projects/${pid}/nodes`, body),
  updateNode: (nid: string, body: {
    name?: string;
    order?: number;
    is_leaf?: boolean;
    measurement_type?: 'coord_latlon' | 'cadenamiento' | 'eje' | 'nivel' | null;
    target_lat?: number | null;
    target_lon?: number | null;
    target_elev?: number | null;
    meta?: number | null;
  }) => request<LocationNode>('PATCH', `/nodes/${nid}`, body),
  deleteNode: (nid: string) => request<{ ok: boolean; deleted_count: number }>('DELETE', `/nodes/${nid}`),

  // ── Portadilla institucional del nodo (cover_image) ─────────────────────
  // Sube una imagen JPG/PNG/WebP (máx 8MB) que se usará como fondo de la
  // portadilla dinámica del PDF exportado. La imagen aplica al nodo y a todos
  // sus descendientes (a menos que un descendiente tenga su propia portada).
  uploadNodeCover: async (
    pid: string,
    nid: string,
    file: { uri: string; name: string; mimeType?: string | null },
  ): Promise<LocationNode> => {
    const form = new FormData();
    const isWeb = typeof window !== 'undefined' && typeof (globalThis as any).Blob !== 'undefined';
    const fileName = file.name || 'cover.jpg';
    const mime = file.mimeType || 'image/jpeg';
    if (isWeb) {
      const resBlob = await fetch(file.uri);
      const blob = await resBlob.blob();
      try {
        const f = new File([blob], fileName, { type: mime });
        form.append('file', f);
      } catch {
        form.append('file', blob, fileName);
      }
    } else {
      let normalizedUri = file.uri;
      const needsCopy =
        Platform.OS === 'android'
          ? !file.uri.startsWith('file://')
          : file.uri.startsWith('ph://') || file.uri.startsWith('assets-library://');
      if (needsCopy) {
        try {
          const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
          const dest = `${FileSystem.cacheDirectory}cover_${Date.now()}_${safeName}`;
          await FileSystem.copyAsync({ from: file.uri, to: dest });
          normalizedUri = dest;
        } catch {
          /* ignore */
        }
      }
      if (Platform.OS === 'android' && normalizedUri.startsWith('/')) {
        normalizedUri = 'file://' + normalizedUri;
      }
      form.append('file', { uri: normalizedUri, name: fileName, type: mime } as any);
    }
    const headers = await authHeader();
    const res = await fetch(`${BASE}/projects/${pid}/nodes/${nid}/cover`, {
      method: 'POST',
      headers,
      body: form as any,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data && (data as any).detail) || `HTTP ${res.status}`;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data as LocationNode;
  },

  deleteNodeCover: (pid: string, nid: string) =>
    request<LocationNode>('DELETE', `/projects/${pid}/nodes/${nid}/cover`),

  // Bulk upload de nodos desde Excel/CSV (FormData). Compatible web + native.
  bulkUploadNodes: async (
    pid: string,
    file: { uri: string; name: string; mimeType?: string | null },
  ): Promise<{
    total_rows: number;
    created: number;
    updated: number;
    skipped: number;
    errors: { row: number; error: string }[];
    name_column: string;
    parent_column: string | null;
    metadata_columns: string[];
  }> => {
    const form = new FormData();
    const isWeb = typeof window !== 'undefined' && typeof (globalThis as any).Blob !== 'undefined';
    const fileName = file.name || 'nodos.xlsx';
    const mime =
      file.mimeType ||
      (fileName.toLowerCase().endsWith('.csv')
        ? 'text/csv'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (isWeb) {
      // En web, DocumentPicker devuelve un blob: URL o data URL. Hay que materializar el Blob.
      const resBlob = await fetch(file.uri);
      const blob = await resBlob.blob();
      // Re-envolver con el filename correcto.
      try {
        const f = new File([blob], fileName, { type: mime });
        form.append('file', f);
      } catch {
        // Algunos navegadores antiguos no soportan File constructor.
        form.append('file', blob, fileName);
      }
    } else {
      // En React Native nativo, el objeto { uri, name, type } sí es soportado.
      form.append('file', {
        uri: file.uri,
        name: fileName,
        type: mime,
      } as any);
    }
    const headers = await authHeader();
    const res = await fetch(`${BASE}/projects/${pid}/nodes/bulk-upload`, {
      method: 'POST',
      headers, // No establecer Content-Type, fetch añade boundary automático.
      body: form as any,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data && (data as any).detail) || `HTTP ${res.status}`;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data as any;
  },

  // URL absoluta para descargar la plantilla Excel de nodos (incluye token en header en native).
  bulkUploadNodesTemplateUrl: (pid: string) => `${BASE}/projects/${pid}/nodes/bulk-upload/template`,

  /**
   * Sube un archivo genérico al proyecto (multipart/form-data).
   * - Si es Excel/CSV → ejecuta carga masiva de nodos y devuelve `summary`.
   * - Si es PDF/Word → lo guarda y devuelve la metadata del archivo (con file_id + url descargable).
   */
  uploadProjectFile: async (
    pid: string,
    file: { uri: string; name: string; mimeType?: string | null },
  ): Promise<{
    type: 'nodes_bulk' | 'stored';
    filename: string;
    mime_type?: string;
    size?: number;
    summary?: {
      total_rows: number;
      created: number;
      updated: number;
      skipped: number;
      errors: { row: number; error: string }[];
    };
    file?: ReferenceFile;
  }> => {
    const form = new FormData();
    const isWeb = typeof window !== 'undefined' && typeof (globalThis as any).Blob !== 'undefined';
    const fileName = file.name || 'archivo';
    const mime = file.mimeType || 'application/octet-stream';
    if (isWeb) {
      const resBlob = await fetch(file.uri);
      const blob = await resBlob.blob();
      try {
        const f = new File([blob], fileName, { type: mime });
        form.append('file', f);
      } catch {
        form.append('file', blob, fileName);
      }
    } else {
      // En Android los content://, ph://, optimized:// no son siempre legibles
      // por fetch/FormData → se copian al cacheDirectory y se usa file:// estable.
      // En iOS los URIs file:// e incluso ph:// suelen funcionar tras
      // copyToCacheDirectory:true del picker, pero por seguridad normalizamos también.
      let normalizedUri = file.uri;
      const needsCopy =
        Platform.OS === 'android'
          ? !file.uri.startsWith('file://')
          : file.uri.startsWith('ph://') || file.uri.startsWith('assets-library://');
      if (needsCopy) {
        try {
          const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
          const dest = `${FileSystem.cacheDirectory}upload_${Date.now()}_${safeName}`;
          await FileSystem.copyAsync({ from: file.uri, to: dest });
          normalizedUri = dest;
        } catch (copyErr) {
          // Si la copia falla, mantenemos el URI original y dejamos que fetch lo intente.
        }
      }
      // Android exige el prefijo "file://"; algunos pickers devuelven sin él.
      if (Platform.OS === 'android' && normalizedUri.startsWith('/')) {
        normalizedUri = 'file://' + normalizedUri;
      }
      form.append('file', { uri: normalizedUri, name: fileName, type: mime } as any);
    }
    const headers = await authHeader();
    const res = await fetch(`${BASE}/projects/${pid}/upload-file`, {
      method: 'POST',
      headers, // sin Content-Type: fetch añade boundary multipart.
      body: form as any,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data && (data as any).detail) || `HTTP ${res.status}`;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data as any;
  },

  /** Elimina un archivo del proyecto por su file_id (sólo Coord/Jefe). */
  deleteProjectFile: (pid: string, fileId: string) =>
    request<{ ok: boolean; file_id: string }>('DELETE', `/projects/${pid}/files/${fileId}`),

  // ── Plantillas de exportación (PDF / DOCX / PPTX / MAP) ────────────────
  uploadProjectTemplate: async (
    pid: string,
    kind: 'pdf' | 'docx' | 'pptx' | 'map',
    file: { uri: string; name: string; mimeType?: string | null },
  ): Promise<Project> => {
    const form = new FormData();
    const isWeb = typeof window !== 'undefined' && typeof (globalThis as any).Blob !== 'undefined';
    const fileName = file.name || `template.${kind === 'map' ? 'jpg' : kind}`;
    const mime =
      file.mimeType ||
      (kind === 'pdf'
        ? 'application/pdf'
        : kind === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : kind === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'image/jpeg');
    if (isWeb) {
      const resBlob = await fetch(file.uri);
      const blob = await resBlob.blob();
      try {
        const f = new File([blob], fileName, { type: mime });
        form.append('file', f);
      } catch {
        form.append('file', blob, fileName);
      }
    } else {
      let normalizedUri = file.uri;
      const needsCopy =
        Platform.OS === 'android'
          ? !file.uri.startsWith('file://')
          : file.uri.startsWith('ph://') || file.uri.startsWith('assets-library://');
      if (needsCopy) {
        try {
          const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
          const dest = `${FileSystem.cacheDirectory}upload_${Date.now()}_${safeName}`;
          await FileSystem.copyAsync({ from: file.uri, to: dest });
          normalizedUri = dest;
        } catch {
          /* ignore */
        }
      }
      if (Platform.OS === 'android' && normalizedUri.startsWith('/')) {
        normalizedUri = 'file://' + normalizedUri;
      }
      form.append('file', { uri: normalizedUri, name: fileName, type: mime } as any);
    }
    const headers = await authHeader();
    const res = await fetch(`${BASE}/projects/${pid}/template/${kind}`, {
      method: 'POST',
      headers,
      body: form as any,
    });
    const text = await res.text();
    const data = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (data && (data as any).detail) || `HTTP ${res.status}`;
      throw new ApiError(res.status, typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data as Project;
  },

  deleteProjectTemplate: (pid: string, kind: 'pdf' | 'docx' | 'pptx' | 'map') =>
    request<Project>('DELETE', `/projects/${pid}/template/${kind}`),


  /** URL absoluta para descargar un archivo del proyecto (requiere Bearer token en header). */
  projectFileUrl: (pid: string, fileId: string) => `${BASE}/projects/${pid}/files/${fileId}`,

  // Descarga la plantilla y devuelve un Blob (web) o la guarda en cacheDirectory (native).
  downloadNodesTemplate: async (pid: string): Promise<{ blob?: Blob; uri?: string; filename: string }> => {
    const headers = await authHeader();
    const url = `${BASE}/projects/${pid}/nodes/bulk-upload/template`;
    const filename = 'plantilla_nodos_synco.xlsx';
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new ApiError(res.status, `HTTP ${res.status} al descargar la plantilla`);
    }
    const blob = await res.blob();
    return { blob, filename };
  },

  // Descarga un archivo del proyecto (con Bearer token). Devuelve Blob + filename.
  downloadProjectFile: async (
    pid: string,
    fileId: string,
    fallbackFilename?: string,
  ): Promise<{ blob: Blob; filename: string; mime?: string }> => {
    const headers = await authHeader();
    const url = `${BASE}/projects/${pid}/files/${fileId}`;
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new ApiError(res.status, `HTTP ${res.status} al descargar el archivo`);
    }
    // Intentar extraer filename del Content-Disposition.
    let filename = fallbackFilename || 'archivo';
    const cd = res.headers.get('content-disposition') || res.headers.get('Content-Disposition') || '';
    const m = /filename\*?=(?:UTF-8'')?"?([^";\n]+)"?/i.exec(cd);
    if (m && m[1]) {
      try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; }
    }
    const mime = res.headers.get('content-type') || undefined;
    const blob = await res.blob();
    return { blob, filename, mime: mime || undefined };
  },

  // Areas
  listAreas: (pid: string) => request<Area[]>('GET', `/projects/${pid}/areas`),
  createArea: (pid: string, body: { project_id: string; name: string; color?: string }) =>
    request<Area>('POST', `/projects/${pid}/areas`, body),
  deleteArea: (aid: string) => request<{ ok: boolean }>('DELETE', `/areas/${aid}`),

  // Catálogos dinámicos del Proyecto (sólo Coordinador General)
  setProjectCatalogos: (pid: string, body: {
    contratistas_list?: string[];
    contratos_list?: string[];
    categorias_personal?: string[];
    categorias_equipo?: string[];
  }) => request<Project>('PUT', `/projects/${pid}/catalogos`, body),

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
    observaciones?: string | null;
    incidencias?: string | null;
    severidad?: 'informativo' | 'importante' | 'urgente';
    contratista?: string | null;
    personnel?: string[];
    equipment?: string[];
    images?: string[];
    files?: { filename: string; mime: string; data_base64: string }[];
    primera_lectura?: number | null;
    ultima_lectura?: number | null;
    unidad?: string | null;
  }) => request<Report>('POST', '/reports', body),
  nodeHistory: (pid: string, nid: string) =>
    request<{
      node_id: string;
      measurement_type: string | null;
      has_previous: boolean;
      last_report: null | {
        id: string;
        created_at: string;
        captured_by_name: string;
        measurement_value: Record<string, any>;
        primera_lectura: number | null;
        ultima_lectura: number | null;
        avance: string | null;
        notes: string | null;
      };
    }>('GET', `/projects/${pid}/nodes/${nid}/history`),
  listReports: (pid: string) => request<Report[]>('GET', `/projects/${pid}/reports`),
  feed: (pid: string, range: 'today' | 'week' | 'month' | 'all' = 'today', limit = 50) =>
    request<FeedResponse>('GET', `/projects/${pid}/reports/feed?range=${range}&limit=${limit}`),
  getReport: (rid: string) => request<Report>('GET', `/reports/${rid}`),

  // ---- AI Summary (Resumen Ejecutivo con IA) ------------------------------
  aiSummary: (pid: string) =>
    request<{
      summary: string;
      reports_count: number;
      period_hours: number;
      generated_at: string;
    }>('POST', `/projects/${pid}/ai_summary`),

  // ---- Announcements (Noticias) -------------------------------------------
  listAnnouncements: (pid: string) =>
    request<Announcement[]>('GET', `/projects/${pid}/announcements`),
  createAnnouncement: (pid: string, payload: { title: string; body: string; pinned?: boolean; jerarquia?: 'urgente' | 'importante' | 'informativo' | null; severidad?: 'urgente' | 'importante' | 'informativo' | null; audiencia?: string | null; node_id?: string | null }) =>
    request<Announcement>('POST', `/projects/${pid}/announcements`, payload),
  updateAnnouncement: (aid: string, payload: { title?: string; body?: string; pinned?: boolean; jerarquia?: 'urgente' | 'importante' | 'informativo' | null; severidad?: 'urgente' | 'importante' | 'informativo' | null; audiencia?: string | null; node_id?: string | null }) =>
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

  // ---- Export ------------------------------------------------------------
  /** Devuelve URL absoluta para descargar el Excel (Coord). El backend exige Bearer token. */
  exportReportsXlsxUrl: (pid: string) => `${BASE}/projects/${pid}/export/reports.xlsx`,
  /** Descarga el Excel autenticado. En Web abre el archivo (download), en native devuelve Blob. */
  downloadReportsXlsx: async (pid: string): Promise<{ blob: Blob; filename: string }> => {
    const tok = await storage.secureGet<string>('syncsite_token', '');
    const res = await fetch(`${BASE}/projects/${pid}/export/reports.xlsx`, {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(txt); msg = j?.detail || msg; } catch {}
      throw new ApiError(res.status, msg);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = (m && m[1]) || `synco_reportes.xlsx`;
    const blob = await res.blob();
    return { blob, filename };
  },

  /** Motor PDF unificado. period: today | yesterday | week | month */
  downloadReportsPdf: async (
    pid: string,
    period: 'today' | 'yesterday' | 'week' | 'month',
    opts?: { area_id?: string | null; scope?: 'mine' | 'area' | null },
  ): Promise<{ blob: Blob; filename: string }> => {
    const tok = await storage.secureGet<string>('syncsite_token', '');
    const qs = new URLSearchParams({ period });
    if (opts?.area_id) qs.set('area_id', opts.area_id);
    if (opts?.scope) qs.set('scope', opts.scope);
    const res = await fetch(`${BASE}/projects/${pid}/export/reports.pdf?${qs.toString()}`, {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(txt); msg = j?.detail || msg; } catch {}
      throw new ApiError(res.status, msg);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = (m && m[1]) || `reporte_${period}.pdf`;
    const blob = await res.blob();
    return { blob, filename };
  },

  /** Exportar a Word (.docx). period: today | yesterday | week | month */
  downloadReportsDocx: async (
    pid: string,
    period: 'today' | 'yesterday' | 'week' | 'month',
    opts?: { area_id?: string | null; scope?: 'mine' | 'area' | null },
  ): Promise<{ blob: Blob; filename: string }> => {
    const tok = await storage.secureGet<string>('syncsite_token', '');
    const qs = new URLSearchParams({ period });
    if (opts?.area_id) qs.set('area_id', opts.area_id);
    if (opts?.scope) qs.set('scope', opts.scope);
    const res = await fetch(`${BASE}/projects/${pid}/export/reports.docx?${qs.toString()}`, {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(txt); msg = j?.detail || msg; } catch {}
      throw new ApiError(res.status, msg);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = (m && m[1]) || `reporte_${period}.docx`;
    const blob = await res.blob();
    return { blob, filename };
  },

  /** Exportar a PowerPoint (.pptx). period: today | yesterday | week | month */
  downloadReportsPptx: async (
    pid: string,
    period: 'today' | 'yesterday' | 'week' | 'month',
    opts?: { area_id?: string | null; scope?: 'mine' | 'area' | null },
  ): Promise<{ blob: Blob; filename: string }> => {
    const tok = await storage.secureGet<string>('syncsite_token', '');
    const qs = new URLSearchParams({ period });
    if (opts?.area_id) qs.set('area_id', opts.area_id);
    if (opts?.scope) qs.set('scope', opts.scope);
    const res = await fetch(`${BASE}/projects/${pid}/export/reports.pptx?${qs.toString()}`, {
      method: 'GET',
      headers: tok ? { Authorization: `Bearer ${tok}` } : {},
    });
    if (!res.ok) {
      const txt = await res.text();
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(txt); msg = j?.detail || msg; } catch {}
      throw new ApiError(res.status, msg);
    }
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^"]+)"?/);
    const filename = (m && m[1]) || `reporte_${period}.pptx`;
    const blob = await res.blob();
    return { blob, filename };
  },

  // ---- Events (Calendario) ------------------------------------------------
  listEvents: (pid: string, range: 'upcoming' | 'past' | 'all' = 'upcoming', limit = 500) =>
    request<ProjectEvent[]>('GET', `/projects/${pid}/events?range=${range}&limit=${limit}`),
  createEvent: (pid: string, payload: {
    title: string; start_at: string; end_at?: string | null;
    description?: string | null; location?: string | null;
    area_id?: string | null;
  }) => request<ProjectEvent>('POST', `/projects/${pid}/events`, payload),
  updateEvent: (eid: string, payload: Partial<{
    title: string; start_at: string; end_at: string | null;
    description: string | null; location: string | null;
    area_id: string | null;
  }>) => request<ProjectEvent>('PATCH', `/events/${eid}`, payload),
  deleteEvent: (eid: string) =>
    request<{ ok: boolean }>('DELETE', `/events/${eid}`),
  deleteReport: (rid: string) => request<{ ok: boolean }>('DELETE', `/reports/${rid}`),

  // Users (admin)
  listProjectUsers: (pid: string) => request<User[]>('GET', `/projects/${pid}/users`),

  // ---- Daily Goals (Metas del día) ----------------------------------------
  listDailyGoals: (pid: string) =>
    request<DailyGoal[]>('GET', `/projects/${pid}/daily_goals`),
  createDailyGoal: (pid: string, text: string) =>
    request<DailyGoal>('POST', `/projects/${pid}/daily_goals`, { text }),
  updateDailyGoal: (pid: string, gid: string, payload: { text?: string; is_completed?: boolean }) =>
    request<DailyGoal>('PATCH', `/projects/${pid}/daily_goals/${gid}`, payload),
  deleteDailyGoal: (pid: string, gid: string) =>
    request<{ ok: boolean }>('DELETE', `/projects/${pid}/daily_goals/${gid}`),
};

export { BASE };
