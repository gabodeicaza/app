/**
 * Helpers de zona horaria — SynCo opera SIEMPRE en `America/Mexico_City` (CDMX).
 *
 * El backend almacena/expone timestamps en UTC. El frontend debe convertirlos
 * a CDMX para display coherente, sin que el sistema operativo del dispositivo
 * (que puede estar en UTC, PDT, GMT, etc.) cambie la vista.
 *
 * Se apoya en `Intl.DateTimeFormat` con `timeZone: 'America/Mexico_City'`,
 * disponible en Hermes de RN 0.72+.
 */
export const CDMX_TZ = 'America/Mexico_City';
export const CDMX_LOCALE = 'es-MX';

function _toDate(input: string | number | Date | null | undefined): Date | null {
  if (!input) return null;
  try {
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/** `06 jul 2026, 17:42` — para tarjetas y modales. */
export function fmtDateTimeCDMX(input: string | number | Date | null | undefined): string {
  const d = _toDate(input);
  if (!d) return '—';
  try {
    return d.toLocaleString(CDMX_LOCALE, {
      timeZone: CDMX_TZ,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** `06 jul 2026` — solo fecha. */
export function fmtDateCDMX(input: string | number | Date | null | undefined): string {
  const d = _toDate(input);
  if (!d) return '—';
  try {
    return d.toLocaleDateString(CDMX_LOCALE, {
      timeZone: CDMX_TZ,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** `17:42` — solo hora local. */
export function fmtTimeCDMX(input: string | number | Date | null | undefined): string {
  const d = _toDate(input);
  if (!d) return '—';
  try {
    return d.toLocaleTimeString(CDMX_LOCALE, {
      timeZone: CDMX_TZ,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/** `YYYY-MM-DD` calculado en zona CDMX (útil para filtrar por día calendario). */
export function toISODateCDMX(input: string | number | Date | null | undefined): string {
  const d = _toDate(input);
  if (!d) return '';
  try {
    // en-CA → YYYY-MM-DD por default.
    return d.toLocaleDateString('en-CA', { timeZone: CDMX_TZ });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
