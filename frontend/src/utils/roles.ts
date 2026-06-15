// SynCo v2.0 — Roles simplificados.
// Solo existen 3 roles operativos:
//   - coordinador_general (God Mode multi-proyecto)
//   - sub_coordinador     (scope: sub-árbol)
//   - especialista        (scope: hojas asignadas)

export const APP_BRAND = 'SynCo';
export const APP_TAGLINE = 'Reporte de obra inteligente, sin huella local.';

export type AppRole = 'coordinador_general' | 'sub_coordinador' | 'especialista';

export const ROLE_COORD: AppRole = 'coordinador_general';
export const ROLE_SUB: AppRole = 'sub_coordinador';
export const ROLE_ESP: AppRole = 'especialista';

export function roleLabel(role?: string | null, areaName?: string | null): string {
  if (!role) return '—';
  if (role === ROLE_COORD) return 'Coordinador General';
  if (role === ROLE_SUB) return 'Sub-Coordinador';
  if (role === ROLE_ESP) {
    return areaName && areaName.trim() ? `Especialista · ${areaName.trim()}` : 'Especialista';
  }
  return role;
}

export function roleShortLabel(role?: string | null): string {
  if (role === ROLE_COORD) return 'Coord. General';
  if (role === ROLE_SUB) return 'Sub-Coord.';
  if (role === ROLE_ESP) return 'Especialista';
  return '—';
}

export function isCoord(role?: string | null): boolean {
  return role === ROLE_COORD;
}
export function isSubCoord(role?: string | null): boolean {
  return role === ROLE_SUB;
}
export function isEspecialista(role?: string | null): boolean {
  return role === ROLE_ESP;
}

/** Tipo de medición que un nodo hoja exige. */
export type MeasurementType = 'coord_latlon' | 'cadenamiento' | 'eje' | 'nivel';

export const MEASUREMENT_LABELS: Record<MeasurementType, string> = {
  coord_latlon: 'Coordenadas (lat/lon)',
  cadenamiento: 'Cadenamiento (km+m)',
  eje: 'Eje',
  nivel: 'Nivel (m)',
};

export const MEASUREMENT_ICONS: Record<MeasurementType, string> = {
  coord_latlon: 'location-outline',
  cadenamiento: 'analytics-outline',
  eje: 'git-network-outline',
  nivel: 'water-outline',
};

/** Devuelve la ruta de redirect inicial según rol. */
export function homeRouteForRole(role?: string | null): string {
  if (role === ROLE_COORD) return '/(coord)';
  if (role === ROLE_SUB) return '/(subcoord)';
  if (role === ROLE_ESP) return '/(spec)';
  return '/(auth)/login';
}
