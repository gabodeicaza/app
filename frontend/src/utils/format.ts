// Tiny formatting helpers shared across screens.
import dayjs from 'dayjs';
import 'dayjs/locale/es';

dayjs.locale('es');

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  return dayjs(iso).format('DD MMM · HH:mm');
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  return dayjs(iso).format('HH:mm');
}

export function fmtFullDate(iso?: string | null): string {
  if (!iso) return '—';
  return dayjs(iso).format('dddd, DD [de] MMMM');
}
