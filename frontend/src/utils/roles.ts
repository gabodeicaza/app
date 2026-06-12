// Mapeo de roles y branding centralizado para SynCo.
// Roles operativos:
//  - 'especialista'         -> escribe reportes (área asignada).
//  - 'supervisor_t1'        -> solo lectura, scope Tramo 1.
//  - 'supervisor_t2'        -> solo lectura, scope Tramo 2.
//  - 'supervisor_general'   -> solo lectura, visión global.
//  - 'coordinador' (legacy) -> alias de supervisor_general.
//  - 'contratista' / 'dependencia' -> invitados, solo lectura, todos los tramos.

export const APP_BRAND = 'SynCo';
export const APP_TAGLINE = 'Reporte de obra inteligente, sin huella local.';

export type AppRole =
  | 'coordinador'
  | 'especialista'
  | 'supervisor_t1'
  | 'supervisor_t2'
  | 'supervisor_general'
  | 'contratista'
  | 'dependencia';

export function roleLabel(role?: string | null, areaName?: string | null): string {
  if (!role) return '—';
  if (role === 'coordinador' || role === 'supervisor_general') return 'Supervisor General';
  if (role === 'supervisor_t1') return 'Supervisor Tramo 1';
  if (role === 'supervisor_t2') return 'Supervisor Tramo 2';
  if (role === 'contratista') return 'Contratista';
  if (role === 'dependencia') return 'Dependencia';
  // Especialista: mostramos su área (Topografía, Geotecnia, etc.) cuando exista.
  if (areaName && areaName.trim()) return areaName.trim();
  return 'Especialista';
}

export function roleShortLabel(role?: string | null): string {
  if (role === 'coordinador' || role === 'supervisor_general') return 'Supervisor';
  if (role === 'supervisor_t1') return 'Sup. T1';
  if (role === 'supervisor_t2') return 'Sup. T2';
  if (role === 'contratista') return 'Contratista';
  if (role === 'dependencia') return 'Dependencia';
  return 'Especialista';
}

const SUPERVISOR_ROLES = new Set([
  'coordinador',
  'supervisor_general',
  'supervisor_t1',
  'supervisor_t2',
]);
const READ_ONLY_ROLES = new Set([
  ...Array.from(SUPERVISOR_ROLES),
  'contratista',
  'dependencia',
]);

/** El rol está en vista de Supervisor (tableros, resúmenes, noticias). */
export function isSupervisorView(role?: string | null): boolean {
  if (!role) return false;
  return READ_ONLY_ROLES.has(role);
}

/** True solo para invitados sin permiso de mutar (contratista/dependencia). */
export function isGuestReadOnly(role?: string | null): boolean {
  return role === 'contratista' || role === 'dependencia';
}

/** True para roles que NO pueden crear/editar/eliminar reportes/postes/noticias. */
export function isReadOnly(role?: string | null): boolean {
  return !!role && READ_ONLY_ROLES.has(role);
}

/** Solo el rol Especialista puede crear reportes. */
export function canCreateReport(role?: string | null): boolean {
  return role === 'especialista';
}

/** Solo Supervisores (cualquier tipo) pueden emitir Noticias. */
export function canEmitNews(role?: string | null): boolean {
  return !!role && SUPERVISOR_ROLES.has(role);
}

/** Devuelve el tramo asignado a un supervisor (1, 2) o null si ve todos. */
export function tramoScope(role?: string | null): 1 | 2 | null {
  if (role === 'supervisor_t1') return 1;
  if (role === 'supervisor_t2') return 2;
  return null;
}

/** Compat: el form de creación marca "Supervisor de Obra" como read-only de campo. */
export function isReadOnlyField(role?: string | null): boolean {
  return !canCreateReport(role);
}

/** Color del Badge visual al lado del nombre en Chat / Noticias. */
export function roleBadgeColor(role?: string | null): { bg: string; fg: string } {
  if (role === 'coordinador' || role === 'supervisor_general') return { bg: '#DBEAFE', fg: '#1E3A8A' };
  if (role === 'supervisor_t1') return { bg: '#FCE7F3', fg: '#9D174D' };
  if (role === 'supervisor_t2') return { bg: '#E0F2FE', fg: '#075985' };
  if (role === 'contratista') return { bg: '#FEF3C7', fg: '#92400E' };
  if (role === 'dependencia') return { bg: '#E0E7FF', fg: '#3730A3' };
  return { bg: '#DCFCE7', fg: '#166534' };
}
