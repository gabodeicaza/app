// Mapeo de roles y branding centralizado para SynCo.
// Internamente seguimos usando 'coordinador' y 'especialista' para no romper APIs/seed.

export const APP_BRAND = 'SynCo';
export const APP_TAGLINE = 'Reporte de obra inteligente, sin huella local.';

export function roleLabel(role?: string | null, areaName?: string | null): string {
  if (!role) return '—';
  if (role === 'coordinador') return 'Supervisor de Obra';
  // Especialista: mostramos su área (Topografía, Geotecnia, etc.) cuando exista.
  if (areaName && areaName.trim()) return areaName.trim();
  return 'Especialista';
}

export function roleShortLabel(role?: string | null): string {
  if (role === 'coordinador') return 'Supervisor';
  return 'Especialista';
}

export function isReadOnlyField(role?: string | null): boolean {
  // Supervisor de Obra: solo lectura del trabajo de campo (no crea reportes).
  return role === 'coordinador';
}
