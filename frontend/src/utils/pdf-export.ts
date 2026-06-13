// Cero Huella Local: el PDF se genera en una ubicacion temporal y se borra tras compartir.
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { api } from '@/src/api';
import { DIRAC_LOGO_DATAURL } from '@/src/utils/dirac-logo';

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
  /** Rango temporal: 'today' | 'week' | 'month'. Si se especifica, ignora todayOnly. */
  period?: 'today' | 'week' | 'month';
  /** Si se provee, filtra los reportes para incluir solo los creados por este usuario. */
  mineUserId?: string;
  /** Texto opcional para mostrar bajo el título principal del PDF. */
  subtitle?: string;
}

function startOfPeriodIso(period: 'today' | 'week' | 'month'): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === 'week') {
    // Lunes 00:00 local
    const dow = d.getDay(); // 0 dom, 1 lun ...
    const diff = dow === 0 ? 6 : dow - 1;
    d.setDate(d.getDate() - diff);
  } else if (period === 'month') {
    d.setDate(1);
  }
  return d.toISOString();
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

  if (opts.period) {
    const start = startOfPeriodIso(opts.period);
    reports = reports.filter((r: any) => (r.createdAt || '') >= start);
  } else if (opts.todayOnly) {
    const start = startOfTodayIso();
    reports = reports.filter((r: any) => (r.createdAt || '') >= start);
  }

  if (opts.mineUserId) {
    reports = reports.filter((r: any) => r.createdBy === opts.mineUserId);
  }

  const today = new Date();
  const todayStr = today.toLocaleDateString('es-MX', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
  const contract = esc(cfg?.contract) || 'Sin contrato';
  const contractor = esc(cfg?.contractor) || 'Sin contratista';

  // --- Agrupación jerárquica Tramo > Estación > Poste -----------------------
  const renderReport = (r: any) => {
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
      <article class="rep">
        <div class="rep-head">
          <span class="pill">${areaName}</span>
          <span class="by">${esc(r.createdByName)} &middot; ${esc(fmtDate(r.createdAt))}</span>
        </div>
        <h3 class="rep-title">${esc(r.title)}</h3>
        ${r.location ? `<p class="loc"><b>Ubicaci&oacute;n:</b> ${esc(r.location)}${r.coordinates ? ` (${esc(r.coordinates)})` : ''}</p>` : ''}
        ${r.comments ? `<p>${esc(r.comments)}</p>` : ''}
        ${r.activities ? `<p><b>Actividades:</b> ${esc(r.activities)}</p>` : ''}
        ${personnel ? `<p><b>Personal:</b> ${esc(personnel)}</p>` : ''}
        ${equipment ? `<p><b>Equipo:</b> ${esc(equipment)}</p>` : ''}
        ${(r.first_reading !== null && r.first_reading !== undefined) ? `<p><b>Lectura inicial:</b> ${esc(String(r.first_reading))} ${esc(r.unit || '')}</p>` : ''}
        ${(r.last_reading !== null && r.last_reading !== undefined) ? `<p><b>Lectura final:</b> ${esc(String(r.last_reading))} ${esc(r.unit || '')}</p>` : ''}
        ${imgs ? `<div class="grid">${imgs}</div>` : ''}
        ${files ? `<p><b>Archivos adjuntos:</b></p><ul>${files}</ul>` : ''}
      </article>`;
  };

  // Agrupar por tramo -> estacion -> poste
  type Grouped = Record<string, Record<string, Record<string, any[]>>>;
  const grouped: Grouped = {};
  const sinUbicacion: any[] = [];
  for (const r of reports) {
    if (!r.tramo || !r.estacion || !r.poste) {
      sinUbicacion.push(r);
      continue;
    }
    const t = String(r.tramo);
    const e = String(r.estacion);
    const p = String(r.poste);
    grouped[t] = grouped[t] || {};
    grouped[t][e] = grouped[t][e] || {};
    grouped[t][e][p] = grouped[t][e][p] || [];
    grouped[t][e][p].push(r);
  }

  let reportsHtml = '';
  if (reports.length === 0) {
    reportsHtml = `<p class="empty">Sin reportes registrados para el periodo seleccionado.</p>`;
  } else {
    const tramos = Object.keys(grouped).sort((a, b) => Number(a) - Number(b));
    let isFirstTramo = true;
    for (const t of tramos) {
      reportsHtml += `<h2 class="tramo-h ${isFirstTramo ? '' : 'page-break'}">Tramo ${esc(t)}</h2>`;
      isFirstTramo = false;
      const estaciones = Object.keys(grouped[t]).sort((a, b) => Number(a) - Number(b));
      for (const e of estaciones) {
        const count = Object.values(grouped[t][e]).reduce((acc: number, arr: any) => acc + arr.length, 0);
        reportsHtml += `<h3 class="est-h">Estaci&oacute;n ${esc(e)} <span class="est-meta">&middot; ${count} reporte${count === 1 ? '' : 's'}</span></h3>`;
        const postes = Object.keys(grouped[t][e]).sort((a, b) => Number(a) - Number(b));
        for (const p of postes) {
          reportsHtml += `<h4 class="poste-h">Poste ${esc(p)}</h4>`;
          for (const r of grouped[t][e][p]) {
            reportsHtml += renderReport(r);
          }
        }
      }
    }
    if (sinUbicacion.length > 0) {
      reportsHtml += `<h2 class="tramo-h page-break">Reportes sin ubicaci&oacute;n jer&aacute;rquica</h2>`;
      for (const r of sinUbicacion) reportsHtml += renderReport(r);
    }
  }

  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"/><style>
  @page { size: Letter; margin: 18mm 16mm 18mm 16mm; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color:#0F172A; font-size:11pt; line-height:1.45; }
  .head { display:flex; align-items:center; justify-content:space-between; border-bottom:2px solid #0B1B4D; padding-bottom:12px; margin-bottom:14px; }
  .brand { display:flex; align-items:center; gap:14px; }
  .logo { width:120px; height:auto; object-fit:contain; }
  .brand-r { padding:6px 10px; border-radius:8px; background:linear-gradient(135deg,#059669,#10B981); color:#fff; font-weight:900; font-size:10px; letter-spacing:0.6px; }
  .title { font-size:14pt; font-weight:900; margin:0; color:#0B1B4D; }
  .sub { font-size:10pt; color:#475569; margin-top:2px; }
  .meta { text-align:right; font-size:9pt; color:#475569; }
  .meta p { margin:1px 0; }
  .meta b { color:#0F172A; }
  h2 { font-size:12pt; margin:6px 0 4px 0; }
  .tramo-h { font-size:16pt; margin:14px 0 6px 0; color:#0B1B4D; padding:8px 12px; background:#EFF6FF; border-left:5px solid #0B1B4D; border-radius:4px; }
  .est-h { font-size:13pt; margin:14px 0 4px 0; color:#0F172A; border-bottom:1px solid #CBD5E1; padding-bottom:3px; }
  .est-meta { font-size:9pt; color:#64748B; font-weight:600; }
  .poste-h { font-size:11pt; margin:10px 0 2px 0; color:#1E3A8A; }
  article.rep { padding:8px 0 10px 12px; border-left:2px solid #DBEAFE; margin-bottom:6px; }
  .rep-title { font-size:11pt; font-weight:800; margin:2px 0 4px 0; color:#0F172A; }
  section.rep { padding:10px 0; border-bottom:1px solid #E2E8F0; }
  .page-break { page-break-before: always; border-top:none; padding-top:10mm; }
  .rep-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
  .pill { padding:3px 10px; border-radius:999px; font-size:9pt; font-weight:800; background:#EFF6FF; color:#0B1B4D; }
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
      <img class="logo" src="${DIRAC_LOGO_DATAURL}" />
      <div>
        <p class="title">Reporte Consolidado de Obra</p>
        <p class="sub">Dirac Ingenieros Consultores &middot; Cableb&uacute;s L&iacute;nea 4</p>
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
    Documento generado por SynCo &mdash; Dirac Ingenieros Consultores. Las im&aacute;genes incluyen sello anti-fraude (GPS + fecha + hora).
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
