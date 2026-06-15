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
  personal: string;
  equipo: string;
  /** Opcional, override de fecha; por defecto usa "hoy". */
  date?: Date;
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
  // Si no hay nodo padre (especialista capturando en un nodo raíz hoja),
  // mostramos el nodo hoja sin prefijo.
  if ((p.parentNodeName || '').trim()) {
    lines.push(`${p.parentNodeName.trim()}: ${(p.leafNodeName || '').trim()}`);
  } else {
    lines.push((p.leafNodeName || '').trim());
  }
  lines.push(`Ubicación: ${(p.ubicacion || '').trim()}`);
  lines.push('');
  lines.push(`Contratista: ${(p.contratista || '').trim()}`);
  lines.push(`Personal: ${(p.personal || '').trim()}`);
  lines.push(`Equipo: ${(p.equipo || '').trim()}`);
  return lines.join('\n');
}
