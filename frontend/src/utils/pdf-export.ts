// Cero Huella Local: el PDF se genera en una ubicacion temporal y se borra tras compartir.
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { api } from '@/src/api';

function esc(s?: string | null): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
}

function fmtDate(iso?: string) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('es-MX'); } catch { return iso; }
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface ExportOptions {
  /** Si true, solo incluye reportes del dia en curso. */
  todayOnly?: boolean;
}

/**
 * Construye un PDF tamano CARTA con membrete simulado (Dirac + Cablebus L4),
 * consolidando los reportes del backend e incluyendo fotos en data URL.
 * Devuelve la URI del PDF temporal (que se borra a los 20s).
 */
export async function exportSupervisorReport(opts: ExportOptions = {}): Promise<void> {
  let reports: any[] = [];
  let cfg: any = {};
  try {
    reports = await api.listReports();
    cfg = await api.getSiteConfig();
  } catch (e: any) {
    throw new Error('No se pudieron cargar los reportes: ' + (e?.message || e));
  }

  if (opts.todayOnly) {
    const start = startOfTodayIso();
    reports = reports.filter((r: any) => (r.createdAt || '') >= start);
  }

  const today = new Date();
  const todayStr = today.toLocaleDateString('es-MX', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
  const contract = esc(cfg?.contract) || 'Sin contrato';
  const contractor = esc(cfg?.contractor) || 'Sin contratista';

  const reportsHtml = reports.length === 0
    ? `<p class="empty">Sin reportes registrados para el periodo seleccionado.</p>`
    : reports.map((r: any, i: number) => {
        const imgs = (r.images || []).slice(0, 6).map((src: string) =>
          `<img class="ev" src="${src}" />`,
        ).join('');
        const personnel = (r.personnel || []).join(', ');
        const equipment = (r.equipment || []).join(', ');
        const files = (r.files || []).map((f: any) =>
          `<li>${esc(f.name)} <span class="muted">(${esc(f.mimeType)})</span></li>`,
        ).join('');
        const areaName = esc(r.areaName) || '&Aacute;rea';
        return `
          <section class="rep ${i > 0 ? 'page-break' : ''}">
            <div class="rep-head">
              <span class="pill">${areaName}</span>
              <span class="by">${esc(r.createdByName)} &middot; ${esc(fmtDate(r.createdAt))}</span>
            </div>
            <h2>${esc(r.title)}</h2>
            ${r.location ? `<p class="loc"><b>Ubicaci&oacute;n:</b> ${esc(r.location)}${r.coordinates ? ` (${esc(r.coordinates)})` : ''}</p>` : ''}
            ${r.comments ? `<p>${esc(r.comments)}</p>` : ''}
            ${r.activities ? `<p><b>Actividades:</b> ${esc(r.activities)}</p>` : ''}
            ${personnel ? `<p><b>Personal:</b> ${esc(personnel)}</p>` : ''}
            ${equipment ? `<p><b>Equipo:</b> ${esc(equipment)}</p>` : ''}
            ${(r.first_reading !== null && r.first_reading !== undefined) ? `<p><b>Lectura inicial:</b> ${esc(String(r.first_reading))} ${esc(r.unit || '')}</p>` : ''}
            ${(r.last_reading !== null && r.last_reading !== undefined) ? `<p><b>Lectura final:</b> ${esc(String(r.last_reading))} ${esc(r.unit || '')}</p>` : ''}
            ${imgs ? `<div class="grid">${imgs}</div>` : ''}
            ${files ? `<p><b>Archivos adjuntos:</b></p><ul>${files}</ul>` : ''}
          </section>`;
      }).join('');

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/><style>
  @page { size: Letter; margin: 18mm 16mm 18mm 16mm; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color:#0F172A; font-size:11pt; line-height:1.45; }
  .head { display:flex; align-items:center; justify-content:space-between; border-bottom:2px solid #1E3A8A; padding-bottom:10px; margin-bottom:14px; }
  .brand { display:flex; align-items:center; gap:14px; }
  .logo { width:58px; height:58px; border-radius:10px; background:linear-gradient(135deg,#1E3A8A,#2563EB); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:22px; letter-spacing:1px; }
  .brand-r { width:58px; height:58px; border-radius:10px; background:linear-gradient(135deg,#059669,#10B981); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:10px; text-align:center; padding:0 4px; line-height:12px; }
  .title { font-size:14pt; font-weight:900; margin:0; color:#0F172A; }
  .sub { font-size:10pt; color:#475569; margin-top:2px; }
  .meta { text-align:right; font-size:9pt; color:#475569; }
  .meta p { margin:1px 0; }
  .meta b { color:#0F172A; }
  h2 { font-size:12pt; margin:6px 0 4px 0; }
  section.rep { padding:10px 0; border-bottom:1px solid #E2E8F0; }
  .page-break { page-break-before: always; border-top:none; padding-top:10mm; }
  .rep-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
  .pill { padding:3px 10px; border-radius:999px; font-size:9pt; font-weight:800; background:#EFF6FF; color:#1E3A8A; }
  .by { font-size:9pt; color:#475569; }
  p { margin:4px 0; }
  .loc { color:#334155; font-size:10pt; }
  .muted { color:#64748B; font-size:9pt; }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; margin-top:6px; }
  img.ev { width:100%; height:120px; object-fit:cover; border-radius:6px; border:1px solid #CBD5E1; }
  .empty { text-align:center; color:#64748B; padding:40px 0; }
  .firma-row { display:grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top:34mm; page-break-inside:avoid; }
  .firma { border-top:1px solid #0F172A; padding-top:6px; text-align:center; font-size:9pt; color:#0F172A; }
  .footer-note { margin-top:24px; padding-top:8px; border-top:1px solid #E2E8F0; color:#94A3B8; font-size:8pt; text-align:center; }
</style></head><body>
  <header class="head">
    <div class="brand">
      <div class="logo">D</div>
      <div class="brand-r">CABLEB&Uacute;S L4</div>
      <div>
        <p class="title">SynCo &mdash; Reporte Consolidado</p>
        <p class="sub">Dirac Ingenier&iacute;a &middot; Cableb&uacute;s L&iacute;nea 4 (membrete simulado)</p>
      </div>
    </div>
    <div class="meta">
      <p><b>Fecha:</b> ${esc(todayStr)}</p>
      <p><b>Contrato:</b> ${contract}</p>
      <p><b>Contratista:</b> ${contractor}</p>
      <p><b>Total reportes:</b> ${reports.length}</p>
    </div>
  </header>
  ${reportsHtml}
  <div class="firma-row">
    <div class="firma">Supervisor de Obra</div>
    <div class="firma">Representante del Contratista</div>
  </div>
  <div class="footer-note">
    Documento generado autom&aacute;ticamente por SynCo. Las im&aacute;genes incluyen sello anti-fraude (GPS + fecha).
  </div>
</body></html>`;

  const { uri } = await Print.printToFileAsync({ html, base64: false });
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      dialogTitle: 'Exportar reporte SynCo',
      UTI: 'com.adobe.pdf',
    });
  }
  // Borrar PDF temporal despues de compartir (Cero Huella Local).
  setTimeout(() => { FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {}); }, 20000);
}
