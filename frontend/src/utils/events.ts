// SynCo v2.0 — Helpers de formato/agrupación de eventos.
import { ProjectEvent } from '@/src/api';

export interface EventSection {
  key: string;
  title: string;
  items: ProjectEvent[];
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function daysDiff(target: Date, reference: Date): number {
  // Diferencia en días basada en fecha local (ignorando hora).
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const b = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}

/**
 * Agrupa una lista de eventos por sección temporal.
 *   range='upcoming' → Hoy / Mañana / Esta semana / Más adelante
 *   range='past'     → Esta semana (pasados) / Anteriores
 */
export function groupEvents(items: ProjectEvent[], range: 'upcoming' | 'past'): EventSection[] {
  const now = new Date();
  if (range === 'upcoming') {
    const buckets: Record<string, ProjectEvent[]> = {
      today: [], tomorrow: [], week: [], later: [],
    };
    for (const e of items) {
      const d = new Date(e.start_at);
      const diff = daysDiff(d, now);
      if (sameDay(d, now)) buckets.today.push(e);
      else if (diff === 1) buckets.tomorrow.push(e);
      else if (diff > 1 && diff <= 7) buckets.week.push(e);
      else buckets.later.push(e);
    }
    const out: EventSection[] = [];
    if (buckets.today.length) out.push({ key: 'today', title: 'Hoy', items: buckets.today });
    if (buckets.tomorrow.length) out.push({ key: 'tomorrow', title: 'Mañana', items: buckets.tomorrow });
    if (buckets.week.length) out.push({ key: 'week', title: 'Esta semana', items: buckets.week });
    if (buckets.later.length) out.push({ key: 'later', title: 'Más adelante', items: buckets.later });
    return out;
  }
  // past
  const recent: ProjectEvent[] = [];
  const older: ProjectEvent[] = [];
  for (const e of items) {
    const d = new Date(e.start_at);
    const diff = -daysDiff(d, now);
    if (diff <= 7) recent.push(e);
    else older.push(e);
  }
  const out: EventSection[] = [];
  if (recent.length) out.push({ key: 'recent_past', title: 'Esta semana (pasada)', items: recent });
  if (older.length) out.push({ key: 'older', title: 'Anteriores', items: older });
  return out;
}

export function formatEventTime(e: ProjectEvent): string {
  const start = new Date(e.start_at);
  const time = start.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  if (!e.end_at) return time;
  const end = new Date(e.end_at);
  const endTime = end.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  if (sameDay(start, end)) return `${time} – ${endTime}`;
  const endDate = end.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
  return `${time} → ${endDate} ${endTime}`;
}

export function formatEventDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}
