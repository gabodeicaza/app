// SynCo v2.0 — Generador del "Modo WhatsApp".
// Construye el texto exacto que el Especialista copia al portapapeles tras
// finalizar una captura, listo para pegar en WhatsApp.

const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export function formatDateLongES(d: Date = new Date()): string {
  const day = d.getDate();
  const month = MESES_ES[d.getMonth()];
  const year = d.getFullYear();
  return `${day} de ${month} de ${year}.`;
}

/**
 * Convierte un measurement_value y su measurement_type en texto legible para
 * la línea "Ubicación:" del reporte WhatsApp.
 */
export function formatMeasurementValue(
  measurementType: string,
  value: Record<string, any> | null | undefined,
): string {
  if (!value) return '—';
  switch (measurementType) {
    case 'coord_latlon': {
      const lat = Number(value.lat);
      const lon = Number(value.lon);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
      }
      return '—';
    }
    case 'cadenamiento':
      return String(value.cadenamiento || value.value || '—');
    case 'eje':
      return String(value.eje || value.value || '—');
    case 'nivel': {
      const v = value.nivel ?? value.value;
      if (typeof v === 'number' && Number.isFinite(v)) {
        return `${v} m`;
      }
      return v != null ? String(v) : '—';
    }
    default:
      try { return JSON.stringify(value); } catch { return '—'; }
  }
}

export interface WhatsAppPayload {
  /** Nombre completo del especialista (sin "Ing."). */
  userName: string;
  /** Área (disciplina) o Puesto del especialista. */
  areaOrPuesto: string;
  /** Número de contrato del proyecto. */
  contractNumber: string;
  /** Nodo padre directo del nodo hoja seleccionado (ej. "Estación 02+450"). */
  parentNodeName: string;
  /** Nodo hoja seleccionado (ej. "Poste 12"). */
  leafNodeName: string;
  /** Texto ya formateado del valor de medición (ver formatMeasurementValue). */
  ubicacion: string;
  /** Texto libre ingresado por el especialista. */
  contratista: string;
  /** Listas serializadas (ej. ["3 Albañil", "1 Maestro"]). */
  personal: string[];
  equipo: string[];
  /** Actividades del día (texto libre multiline). */
  actividades?: string;
  /** Observaciones del día (texto libre multiline). */
  observaciones?: string;
  /** Lecturas numéricas. */
  primeraLectura?: number | null;
  ultimaLectura?: number | null;
  /** Opcional, override de fecha; por defecto usa "hoy". */
  date?: Date;
}

function fmtNum(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  // Acepta entero o decimal según corresponda.
  return Number.isInteger(n) ? String(n) : String(n);
}

export function buildWhatsAppMessage(p: WhatsAppPayload): string {
  const dateLine = formatDateLongES(p.date || new Date());
  const lines: string[] = [];
  lines.push(dateLine);
  lines.push('');
  lines.push(`Ing. ${(p.userName || '').trim()}`);
  if ((p.areaOrPuesto || '').trim()) {
    lines.push(p.areaOrPuesto.trim());
  }
  lines.push('');
  lines.push(`No de contrato: ${(p.contractNumber || '').trim()}`);
  if ((p.parentNodeName || '').trim()) {
    lines.push(`${p.parentNodeName.trim()}: ${(p.leafNodeName || '').trim()}`);
  } else {
    lines.push((p.leafNodeName || '').trim());
  }
  lines.push(`Ubicación: ${(p.ubicacion || '').trim()}`);

  // Lecturas (solo si vienen)
  const pl = fmtNum(p.primeraLectura);
  const ul = fmtNum(p.ultimaLectura);
  if (pl != null || ul != null) {
    lines.push('');
    if (pl != null) lines.push(`Primera lectura: ${pl}`);
    if (ul != null) lines.push(`Última lectura: ${ul}`);
  }

  // Actividades
  const act = (p.actividades || '').trim();
  if (act) {
    lines.push('');
    lines.push('Actividades:');
    lines.push(act);
  }

  // Observaciones
  const obs = (p.observaciones || '').trim();
  if (obs) {
    lines.push('');
    lines.push('Observaciones:');
    lines.push(obs);
  }

  // Contratista, Personal y Equipo
  lines.push('');
  lines.push(`Contratista: ${(p.contratista || '').trim()}`);

  const personal = (p.personal || []).map((s) => s.trim()).filter(Boolean);
  lines.push('Personal:');
  if (personal.length) {
    for (const item of personal) lines.push(`• ${item}`);
  } else {
    lines.push('—');
  }

  const equipo = (p.equipo || []).map((s) => s.trim()).filter(Boolean);
  lines.push('Equipo:');
  if (equipo.length) {
    for (const item of equipo) lines.push(`• ${item}`);
  } else {
    lines.push('—');
  }

  return lines.join('\n');
}
