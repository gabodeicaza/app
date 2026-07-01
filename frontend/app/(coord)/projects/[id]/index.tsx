import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, Alert, Platform,
  Linking, Modal, Image, TextInput, KeyboardAvoidingView,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api, Project, ReferenceFile, FeedItem } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';
import { ReportPeriod } from '@/src/components/PeriodSheet';
import { downloadBlob } from '@/src/utils/downloadBlob';
import { DailyGoalsPanel } from '@/src/components/DailyGoalsPanel';
import { NodeProgressPanel } from '@/src/components/NodeProgressPanel';
import { HistoryCalendarModal } from '@/src/components/HistoryCalendarModal';
import { ReportPreviewSheet } from '@/src/components/ReportPreviewSheet';

// Límite cliente coherente con backend (20 MB). Evita subidas que el servidor rechazaría.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Tipos MIME aceptados para el picker (Excel/CSV/PDF/Word).
const UPLOAD_ACCEPTED_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx', '.xls', '.csv', '.pdf', '.doc', '.docx',
];

function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// === Flujo de Exportación en 2 pasos ====================================
type ExportFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';
type ExportStep = 'period' | 'area' | 'format';

const PERIOD_OPTIONS: { value: ReportPeriod; label: string; sub: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 'today',     label: 'Hoy',         sub: 'Reportes capturados hoy',  icon: 'today-outline' },
  { value: 'yesterday', label: 'Ayer',        sub: 'Reportes del día anterior', icon: 'calendar-clear-outline' },
  { value: 'week',      label: 'Esta semana', sub: 'Últimos 7 días',            icon: 'calendar-outline' },
  { value: 'month',     label: 'Este mes',    sub: 'Últimos 30 días',           icon: 'calendar-number-outline' },
];

const FORMAT_OPTIONS: { value: ExportFormat; label: string; sub: string; icon: keyof typeof Ionicons.glyphMap; tint: string }[] = [
  { value: 'pdf',  label: 'PDF',        sub: 'Documento horizontal listo para imprimir', icon: 'document-text', tint: '#DC2626' },
  { value: 'docx', label: 'Word',       sub: 'Editable en Microsoft Word',                icon: 'document',      tint: '#1D4ED8' },
  { value: 'pptx', label: 'PowerPoint', sub: 'Presentación con portada DIRAC',            icon: 'easel',         tint: '#B45309' },
  { value: 'xlsx', label: 'Excel',      sub: 'Sábana plana con jerarquía y coords',       icon: 'grid',          tint: '#059669' },
];

export default function ProjectDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = (Array.isArray(id) ? id[0] : id) || '';
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reports para alimentar NodeProgressPanel y HistoryCalendarModal
  const [reports, setReports] = useState<FeedItem[]>([]);
  const [calendarOpen, setCalendarOpen] = useState(false);

  // Filtrado cruzado: Nodo (Tramo/Subtramo/Poste) × Área (Disciplina)
  const [selectedNodeFilter, setSelectedNodeFilter] = useState<string | null>(null);
  const [selectedAreaFilter, setSelectedAreaFilter] = useState<string | null>(null);

  // Resumen Ejecutivo con IA
  const [aiOpen, setAiOpen] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiMeta, setAiMeta] = useState<{ reports_count: number; period_hours: number } | null>(null);
  const [aiCopied, setAiCopied] = useState(false);

  // Tabs: Operación / Configuración
  const [activeTab, setActiveTab] = useState<'operacion' | 'configuracion'>('operacion');

  // Exportación unificada (3 pasos: período → área → formato)
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStep, setExportStep] = useState<ExportStep>('period');
  const [exportPeriod, setExportPeriod] = useState<ReportPeriod>('today');
  const [exportBusy, setExportBusy] = useState(false);
  // P0 Mega-Feature: filtro por Área para exportación
  const [exportAreas, setExportAreas] = useState<Array<{ id: string; name: string; color?: string }>>([]);
  const [exportAreaId, setExportAreaId] = useState<string | null>(null); // null = "Todas"

  // Preview de reporte (tap en feed)
  const [previewItem, setPreviewItem] = useState<FeedItem | null>(null);

  // Archivos de Consulta (Reference Files) — ahora vía expo-document-picker.
  const [refBusy, setRefBusy] = useState(false);
  const [refUploadName, setRefUploadName] = useState<string | null>(null); // nombre archivo en curso
  const [refOpeningId, setRefOpeningId] = useState<string | null>(null);   // file_id en descarga

  // P0 Mega-Feature: configuración de Catálogos dinámicos (personal/equipo)
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [catSaving, setCatSaving] = useState(false);
  const [catPersonalList, setCatPersonalList] = useState<string[]>([]);
  const [catEquipoList, setCatEquipoList] = useState<string[]>([]);
  const [catPersonalDraft, setCatPersonalDraft] = useState('');
  const [catEquipoDraft, setCatEquipoDraft] = useState('');

  // P0 — Identidad institucional (objeto_contrato + cliente_principal + color_tema)
  const [objetoModalOpen, setObjetoModalOpen] = useState(false);

  // P0 Mega-Feature: Plantillas de exportación (PDF/DOCX/PPTX)
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [tplBusyKind, setTplBusyKind] = useState<'pdf' | 'docx' | 'pptx' | null>(null);
  const [objetoSaving, setObjetoSaving] = useState(false);
  const [objetoDraft, setObjetoDraft] = useState('');
  const [clienteDraft, setClienteDraft] = useState('');
  const [colorDraft, setColorDraft] = useState('#003366');

  const load = useCallback(async () => {
    try {
      setError(null);
      const p = await api.getProject(pid);
      setProject(p);
    } catch (e: any) {
      setError(e?.message || 'Error al cargar');
    } finally {
      setLoading(false);
    }
  }, [pid]);

  // Carga feed completo (range='all') para alimentar gráficas y calendario
  const loadFeed = useCallback(async () => {
    if (!pid) return;
    try {
      const f = await api.feed(pid, 'all', 500);
      setReports(f?.reports || []);
    } catch {
      // Silencioso: el panel mostrará estado vacío.
    }
  }, [pid]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { loadFeed(); }, [loadFeed]);

  // === Nodos (Tramos) y Áreas (Disciplinas) únicos derivados de los reportes ====
  const nodes = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const r of reports) {
      const top = r.node_path_names && r.node_path_names[0];
      if (top && typeof top === 'string') set.add(top);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [reports]);

  const areas = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const r of reports) {
      const a = (r as any).area_name;
      if (a && typeof a === 'string') set.add(a);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'es'));
  }, [reports]);

  const filteredReports = useMemo<FeedItem[]>(() => {
    if (!selectedNodeFilter && !selectedAreaFilter) return reports;
    return reports.filter((r) => {
      const top = (r.node_path_names && r.node_path_names[0]) || null;
      const areaName = (r as any).area_name || null;
      const matchesNode = !selectedNodeFilter || top === selectedNodeFilter;
      const matchesArea = !selectedAreaFilter || areaName === selectedAreaFilter;
      return matchesNode && matchesArea;
    });
  }, [reports, selectedNodeFilter, selectedAreaFilter]);

  // === Resumen Ejecutivo con IA ===========================================
  async function openAiSummary() {
    setAiOpen(true);
    setAiCopied(false);
    if (aiSummary) return; // ya generado en esta sesión; usuario puede regenerar manualmente
    await runAiSummary();
  }

  async function runAiSummary() {
    if (!pid) return;
    try {
      setAiBusy(true);
      setAiError(null);
      setAiSummary(null);
      setAiMeta(null);
      const res = await api.aiSummary(pid);
      setAiSummary(res.summary);
      setAiMeta({ reports_count: res.reports_count, period_hours: res.period_hours });
    } catch (e: any) {
      setAiError(e?.message || 'No se pudo generar el resumen.');
    } finally {
      setAiBusy(false);
    }
  }

  async function copyAiSummary() {
    if (!aiSummary) return;
    try {
      await Clipboard.setStringAsync(aiSummary);
      setAiCopied(true);
      setTimeout(() => setAiCopied(false), 1800);
    } catch {
      Alert.alert('No se pudo copiar', 'Intenta seleccionar el texto manualmente.');
    }
  }

  async function persistRefs(next: ReferenceFile[]) {
    try {
      setRefBusy(true);
      const res = await api.setProjectReferenceFiles(pid, next);
      setProject((p) => (p ? { ...p, reference_files: res.reference_files } : p));
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Inténtalo nuevamente.');
    } finally {
      setRefBusy(false);
    }
  }

  // === Subida real con expo-document-picker → multipart al backend ===========
  async function onPickAndUploadFile() {
    if (refBusy) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: UPLOAD_ACCEPTED_TYPES,
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];

      // Validación cliente del tamaño (20 MB).
      if (asset.size && asset.size > MAX_UPLOAD_BYTES) {
        Alert.alert(
          'Archivo demasiado grande',
          `El archivo pesa ${formatBytes(asset.size)}. El máximo permitido es 20 MB para asegurar la subida en zonas con red baja.`,
        );
        return;
      }

      setRefBusy(true);
      setRefUploadName(asset.name || 'archivo');
      const res = await api.uploadProjectFile(pid, {
        uri: asset.uri,
        name: asset.name || 'archivo',
        mimeType: asset.mimeType,
      });

      if (res.type === 'nodes_bulk' && res.summary) {
        const s = res.summary;
        const lines = [
          `Nuevos: ${s.created}`,
          `Actualizados: ${s.updated}`,
          `Omitidos (filas vacías): ${s.skipped}`,
        ];
        if (s.errors?.length) {
          lines.push('');
          lines.push(`Errores: ${s.errors.length}`);
          for (const e of s.errors.slice(0, 5)) {
            lines.push(`· Fila ${e.row}: ${e.error}`);
          }
        }
        Alert.alert('Nodos importados', lines.join('\n'));
      } else {
        Alert.alert('Archivo subido', `“${res.filename}” se adjuntó al proyecto.`);
      }

      // Refrescar proyecto para reflejar reference_files actualizados.
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo subir', e?.message || 'Error desconocido al subir el archivo.');
    } finally {
      setRefBusy(false);
      setRefUploadName(null);
    }
  }

  async function onRemoveRefFile(idx: number) {
    const current = project?.reference_files || [];
    const target = current[idx];
    if (!target) return;
    const ok = await confirm(
      'Eliminar archivo',
      `¿Quitar “${target.name || 'archivo'}” del proyecto?`,
      { confirmText: 'Eliminar', destructive: true },
    );
    if (!ok) return;
    try {
      setRefBusy(true);
      if (target.file_id) {
        // Archivo subido al servidor → borrar registro + binario.
        const res = await api.deleteProjectFile(pid, target.file_id);
        if (res?.ok) {
          setProject((p) =>
            p ? { ...p, reference_files: (p.reference_files || []).filter((f) => f.file_id !== target.file_id) } : p,
          );
        } else {
          throw new Error('Respuesta inesperada del servidor.');
        }
      } else {
        // Enlace externo (legacy) → reescribir lista completa.
        const next = current.filter((_, i) => i !== idx);
        await persistRefs(next);
      }
    } catch (e: any) {
      Alert.alert('No se pudo eliminar', e?.message || 'Inténtalo nuevamente.');
    } finally {
      setRefBusy(false);
    }
  }

  // Abrir/descargar archivo. Si tiene file_id (subido al backend) descarga con
  // Bearer token vía fetch y comparte/abre con downloadBlob. Si es URL externa,
  // simplemente abre el enlace.
  async function onOpenRefFile(f: ReferenceFile) {
    try {
      if (f.file_id) {
        setRefOpeningId(f.file_id);
        const { blob, filename, mime } = await api.downloadProjectFile(
          pid,
          f.file_id,
          f.original_name || f.name || 'archivo',
        );
        await downloadBlob(blob, filename, mime || f.mime_type);
      } else if (f.url) {
        await Linking.openURL(f.url);
      } else {
        Alert.alert('Sin destino', 'El archivo no tiene URL asociada.');
      }
    } catch (e: any) {
      Alert.alert('No se pudo abrir', e?.message || 'Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setRefOpeningId(null);
    }
  }

  async function onArchive() {
    const ok = await confirm(
      'Archivar proyecto',
      'El proyecto se ocultará pero sus datos se conservan. ¿Continuar?',
      { confirmText: 'Archivar', destructive: true },
    );
    if (!ok) return;
    try { await api.archiveProject(pid); router.back(); }
    catch (e: any) { Alert.alert('Error', e?.message || 'No se pudo archivar'); }
  }

  // === Catálogos del proyecto: categorías personal/equipo ====================
  function openCatModal() {
    if (!project) return;
    setCatPersonalList(((project as any).categorias_personal as string[]) || []);
    setCatEquipoList(((project as any).categorias_equipo as string[]) || []);
    setCatPersonalDraft('');
    setCatEquipoDraft('');
    setCatModalOpen(true);
  }

  // === Identidad institucional (objeto + cliente + color) ===================
  function openObjetoModal() {
    if (!project) return;
    setObjetoDraft((project as any).objeto_contrato || '');
    setClienteDraft((project as any).cliente_principal || '');
    setColorDraft((project as any).color_tema || '#003366');
    setObjetoModalOpen(true);
  }

  async function saveObjeto() {
    if (!pid || objetoSaving) return;
    try {
      setObjetoSaving(true);
      const upd = await api.updateProject(pid, {
        objeto_contrato: objetoDraft.trim() || null,
        cliente_principal: clienteDraft.trim() || null,
        color_tema: colorDraft.trim() || null,
      } as any);
      setProject((p) => ({ ...(p || ({} as any)), ...upd }));
      setObjetoModalOpen(false);
      Alert.alert('Guardado', 'La identidad institucional del proyecto se actualizó correctamente.');
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Inténtalo nuevamente.');
    } finally {
      setObjetoSaving(false);
    }
  }

  // === Plantillas de exportación (PDF/DOCX/PPTX) ============================
  const TPL_MIMES: Record<'pdf' | 'docx' | 'pptx', string[]> = {
    pdf: ['application/pdf', '.pdf'],
    docx: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.docx',
    ],
    pptx: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.pptx',
    ],
  };

  async function onPickAndUploadTemplate(kind: 'pdf' | 'docx' | 'pptx') {
    if (tplBusyKind) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: TPL_MIMES[kind],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const size = asset.size ?? 0;
      const MAX = 25 * 1024 * 1024;
      if (size && size > MAX) {
        Alert.alert(
          'Plantilla demasiado grande',
          `El archivo pesa ${formatBytes(size)}. El máximo permitido es 25 MB.`,
        );
        return;
      }
      setTplBusyKind(kind);
      const upd = await api.uploadProjectTemplate(pid, kind, {
        uri: asset.uri,
        name: asset.name || `template.${kind}`,
        mimeType: asset.mimeType,
      });
      setProject((p) => ({ ...(p || ({} as any)), ...upd }));
      Alert.alert(
        'Plantilla cargada',
        `La plantilla ${kind.toUpperCase()} se guardó y se usará como fondo al exportar.`,
      );
    } catch (e: any) {
      Alert.alert('No se pudo subir la plantilla', e?.message || 'Inténtalo nuevamente.');
    } finally {
      setTplBusyKind(null);
    }
  }

  async function onDeleteTemplate(kind: 'pdf' | 'docx' | 'pptx') {
    if (tplBusyKind) return;
    const ok = await confirm(
      'Eliminar plantilla',
      `¿Quitar la plantilla ${kind.toUpperCase()} del proyecto? Los reportes volverán al diseño DIRAC por defecto.`,
      { confirmText: 'Eliminar', destructive: true },
    );
    if (!ok) return;
    try {
      setTplBusyKind(kind);
      const upd = await api.deleteProjectTemplate(pid, kind);
      setProject((p) => ({ ...(p || ({} as any)), ...upd }));
    } catch (e: any) {
      Alert.alert('No se pudo eliminar', e?.message || 'Inténtalo nuevamente.');
    } finally {
      setTplBusyKind(null);
    }
  }

  function addCatPersonal() {
    const t = catPersonalDraft.trim();
    if (!t) return;
    setCatPersonalList((arr) => {
      const next = Array.from(new Set([...arr, t]));
      return next;
    });
    setCatPersonalDraft('');
  }

  function addCatEquipo() {
    const t = catEquipoDraft.trim();
    if (!t) return;
    setCatEquipoList((arr) => {
      const next = Array.from(new Set([...arr, t]));
      return next;
    });
    setCatEquipoDraft('');
  }

  async function saveCatalogos() {
    if (!pid || catSaving) return;
    try {
      setCatSaving(true);
      // Guardar catálogos dinámicos (Personal / Equipo).
      // Nota: `objeto_contrato` ya NO se edita aquí — vive en su propio modal (objetoModal).
      const upd2 = await api.setProjectCatalogos(pid, {
        categorias_personal: catPersonalList,
        categorias_equipo: catEquipoList,
      });
      setProject((p) => ({ ...(p || ({} as any)), ...upd2 }));
      setCatModalOpen(false);
      Alert.alert('Guardado', 'La configuración del proyecto se actualizó correctamente.');
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Inténtalo nuevamente.');
    } finally {
      setCatSaving(false);
    }
  }

  // === Exportación: flujo en 3 pasos =========================================
  function openExportFlow() {
    setExportStep('period');
    setExportPeriod('today');
    setExportAreaId(null);
    setExportOpen(true);
    // Cargar áreas en paralelo
    if (pid) {
      api.listAreas(pid)
        .then((list) => setExportAreas(
          (list || []).map((a) => ({ id: a.id, name: a.name, color: a.color })),
        ))
        .catch(() => setExportAreas([]));
    }
  }

  function closeExportFlow() {
    if (exportBusy) return;
    setExportOpen(false);
    setTimeout(() => setExportStep('period'), 200);
  }

  function onPickPeriod(p: ReportPeriod) {
    setExportPeriod(p);
    setExportStep('area');
  }

  function onPickArea(areaId: string | null) {
    setExportAreaId(areaId);
    setExportStep('format');
  }

  async function onPickFormat(fmt: ExportFormat) {
    if (!pid) return;
    try {
      setExportBusy(true);
      if (fmt === 'xlsx') {
        // Excel ignora período (sábana completa). Reusamos descarga existente.
        if (Platform.OS === 'web') {
          const { blob, filename } = await api.downloadReportsXlsx(pid);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = filename; document.body.appendChild(a); a.click();
          a.remove(); URL.revokeObjectURL(url);
        } else {
          const { blob, filename } = await api.downloadReportsXlsx(pid);
          const reader = new FileReader();
          const dataUri: string = await new Promise((resolve, reject) => {
            reader.onerror = () => reject(reader.error);
            reader.onloadend = () => resolve(reader.result as string);
            reader.readAsDataURL(blob);
          });
          const base64 = dataUri.split(',')[1] || '';
          const FileSystem: any = await import('expo-file-system/legacy');
          const Sharing: any = await import('expo-sharing');
          const dest = `${FileSystem.cacheDirectory || ''}${filename}`;
          await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType?.Base64 || 'base64' });
          if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(dest, {
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              dialogTitle: 'Compartir reporte',
            });
          } else {
            Alert.alert('Listo', `Archivo guardado en caché:\n${dest}`);
          }
        }
      } else {
        const opts = exportAreaId ? { area_id: exportAreaId } : undefined;
        let blob: Blob; let filename: string; let mime: string;
        if (fmt === 'docx') {
          const r = await api.downloadReportsDocx(pid, exportPeriod, opts);
          blob = r.blob; filename = r.filename;
          mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else if (fmt === 'pptx') {
          const r = await api.downloadReportsPptx(pid, exportPeriod, opts);
          blob = r.blob; filename = r.filename;
          mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        } else {
          const r = await api.downloadReportsPdf(pid, exportPeriod, opts);
          blob = r.blob; filename = r.filename;
          mime = 'application/pdf';
        }
        await downloadBlob(blob, filename, mime);
      }
      setExportOpen(false);
      setTimeout(() => setExportStep('period'), 200);
    } catch (e: any) {
      Alert.alert(
        `No se pudo generar el ${fmt.toUpperCase()}`,
        e?.message || 'Inténtalo nuevamente.',
      );
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{project?.name || 'Proyecto'}</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : error || !project ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.error} />
            <Text style={styles.errorText}>{error || 'Proyecto no disponible'}</Text>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <InfoRow icon="business-outline" label="Constructora" value={project.constructora} />
              <InfoRow icon="document-text-outline" label="Contrato" value={project.contract_number} />
              {project.start_date ? <InfoRow icon="calendar-outline" label="Inicio" value={project.start_date} /> : null}
              {project.end_date ? <InfoRow icon="calendar-outline" label="Término" value={project.end_date} /> : null}
              {project.description ? <InfoRow icon="chatbox-ellipses-outline" label="Descripción" value={project.description} /> : null}
            </View>

            {/* ===== Pestañas: Operación / Configuración ===== */}
            <View style={styles.tabBar}>
              <Pressable
                onPress={() => setActiveTab('operacion')}
                style={[styles.tabBtn, activeTab === 'operacion' && styles.tabBtnActive]}
              >
                <Ionicons
                  name="construct-outline"
                  size={16}
                  color={activeTab === 'operacion' ? '#fff' : colors.text}
                />
                <Text style={[styles.tabTxt, activeTab === 'operacion' && styles.tabTxtActive]}>
                  Operación
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setActiveTab('configuracion')}
                style={[styles.tabBtn, activeTab === 'configuracion' && styles.tabBtnActive]}
              >
                <Ionicons
                  name="settings-outline"
                  size={16}
                  color={activeTab === 'configuracion' ? '#fff' : colors.text}
                />
                <Text style={[styles.tabTxt, activeTab === 'configuracion' && styles.tabTxtActive]}>
                  Configuración
                </Text>
              </Pressable>
            </View>

            {activeTab === 'configuracion' ? (
              <>
            {/* ===== CONFIGURACIÓN ===== */}
            {/* Calendario histórico */}
            <Pressable
              onPress={() => setCalendarOpen(true)}
              style={({ pressed }) => [styles.calendarBtn, pressed && { opacity: 0.9 }]}
            >
              <View style={styles.tileIcon}>
                <Ionicons name="calendar-outline" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.tileTitle}>Calendario histórico</Text>
                <Text style={styles.tileSub}>Explora actividad por día (heatmap del proyecto)</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>

            <Text style={styles.sectionTitle}>Configuración del proyecto</Text>

            <ActionTile
              icon="git-network-outline"
              title="Árbol de nodos"
              subtitle="Estructura espacial recursiva (tramos, estaciones, hojas)"
              onPress={() => router.push({ pathname: '/(coord)/projects/[id]/tree', params: { id: pid } })}
            />
            <ActionTile
              icon="color-palette-outline"
              title="Áreas / Disciplinas"
              subtitle="Topografía, Geotecnia, Estructuras…"
              onPress={() => router.push({ pathname: '/(coord)/projects/[id]/areas', params: { id: pid } })}
            />
            <ActionTile
              icon="mail-outline"
              title="Invitaciones"
              subtitle="Genera tokens para Sub-Coord. y Especialistas"
              onPress={() => router.push({ pathname: '/(coord)/projects/[id]/invitations', params: { id: pid } })}
            />
            <ActionTile
              icon="color-palette-outline"
              title="Identidad institucional"
              subtitle="Objeto del contrato · Cliente principal · Color institucional"
              onPress={openObjetoModal}
            />
            <ActionTile
              icon="list-circle-outline"
              title="Catálogos (Personal y Equipo)"
              subtitle="Categorías que el especialista verá al capturar reportes"
              onPress={openCatModal}
            />
            <ActionTile
              icon="document-attach-outline"
              title="Plantillas de exportación"
              subtitle="Fondos institucionales PDF · Word · PowerPoint"
              onPress={() => setTplModalOpen(true)}
            />
            <ActionTile
              icon="newspaper-outline"
              title="Noticias"
              subtitle="Publica anuncios visibles para todos los miembros"
              onPress={() => router.push({ pathname: '/(coord)/projects/[id]/announcements' as any, params: { id: pid } })}
            />
            <ActionTile
              icon="calendar-outline"
              title="Eventos del proyecto"
              subtitle="Programa visitas, hitos y reuniones"
              onPress={() => router.push({ pathname: '/(coord)/projects/[id]/events' as any, params: { id: pid } })}
            />
              </>
            ) : (
              <>
            {/* ===== OPERACIÓN ===== */}
            {/* Botón GRANDE: Exportar Reportes (PDF / Word / PPT / Excel) */}
            <Pressable
              onPress={openExportFlow}
              disabled={exportBusy}
              style={({ pressed }) => [
                styles.exportMainBtn,
                exportBusy && { opacity: 0.55 },
                pressed && !exportBusy && { opacity: 0.92 },
              ]}
            >
              {exportBusy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons name="download-outline" size={22} color="#fff" />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.exportMainTitle}>Exportar Reportes</Text>
                <Text style={styles.exportMainSub}>
                  {exportBusy ? 'Generando archivo…' : 'PDF · Word · PowerPoint · Excel'}
                </Text>
              </View>
              {!exportBusy && (
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.85)" />
              )}
            </Pressable>

            {/* Metas Diarias */}
            <DailyGoalsPanel projectId={pid} />

            {/* Killer Feature · Resumen Ejecutivo con IA */}
            <Pressable
              onPress={openAiSummary}
              disabled={aiBusy}
              style={({ pressed }) => [
                styles.aiBtn,
                aiBusy && { opacity: 0.7 },
                pressed && !aiBusy && { opacity: 0.92 },
              ]}
            >
              {aiBusy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Ionicons name="sparkles" size={22} color="#fff" />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.aiBtnTitle}>✨ Generar Resumen Ejecutivo con IA</Text>
                <Text style={styles.aiBtnSub}>
                  {aiBusy ? 'Analizando reportes del día…' : 'Avances, equipo y personal en 3 viñetas (últimas 24h)'}
                </Text>
              </View>
              {!aiBusy && (
                <Ionicons name="chevron-forward" size={20} color="rgba(255,255,255,0.85)" />
              )}
            </Pressable>

            {/* Filtrado cruzado: Nodos (Tramos) × Áreas (Disciplinas) */}
            {(nodes.length > 0 || areas.length > 0) && (
              <View style={styles.chipWrap}>
                <Text style={styles.chipTitle}>Filtrar por tramo y área</Text>

                {/* Fila 1: Nodos / Tramos */}
                {nodes.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipRow}
                  >
                    <Pressable
                      onPress={() => setSelectedNodeFilter(null)}
                      style={[styles.chip, !selectedNodeFilter && styles.chipActive]}
                    >
                      <Ionicons
                        name="apps-outline"
                        size={14}
                        color={!selectedNodeFilter ? '#fff' : colors.text}
                      />
                      <Text style={[styles.chipText, !selectedNodeFilter && styles.chipTextActive]}>
                        Todos ({reports.length})
                      </Text>
                    </Pressable>
                    {nodes.map((n) => {
                      const count = reports.filter((r) => {
                        const top = (r.node_path_names && r.node_path_names[0]) || null;
                        return top === n;
                      }).length;
                      const active = selectedNodeFilter === n;
                      return (
                        <Pressable
                          key={`node-${n}`}
                          onPress={() => setSelectedNodeFilter(active ? null : n)}
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Ionicons
                            name="location-outline"
                            size={14}
                            color={active ? '#fff' : colors.text}
                          />
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {n} ({count})
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}

                {/* Fila 2: Áreas / Disciplinas */}
                {areas.length > 0 && (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={[styles.chipRow, { marginTop: 8 }]}
                  >
                    <Pressable
                      onPress={() => setSelectedAreaFilter(null)}
                      style={[styles.chip, !selectedAreaFilter && styles.chipActive]}
                    >
                      <Ionicons
                        name="grid-outline"
                        size={14}
                        color={!selectedAreaFilter ? '#fff' : colors.text}
                      />
                      <Text style={[styles.chipText, !selectedAreaFilter && styles.chipTextActive]}>
                        Todas las Áreas ({reports.length})
                      </Text>
                    </Pressable>
                    {areas.map((a) => {
                      const count = reports.filter((r) => (r as any).area_name === a).length;
                      const active = selectedAreaFilter === a;
                      return (
                        <Pressable
                          key={`area-${a}`}
                          onPress={() => setSelectedAreaFilter(active ? null : a)}
                          style={[styles.chip, active && styles.chipActive]}
                        >
                          <Ionicons
                            name="construct-outline"
                            size={14}
                            color={active ? '#fff' : colors.text}
                          />
                          <Text style={[styles.chipText, active && styles.chipTextActive]}>
                            {a} ({count})
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                )}
              </View>
            )}

            {/* Avance por Nodo */}
            <NodeProgressPanel projectId={pid} reports={filteredReports} />

            {/* ===== Feed de Reportes (últimos 20) ===== */}
            <Text style={styles.sectionTitle}>Reportes recientes</Text>
            {filteredReports.length === 0 ? (
              <View style={styles.feedEmpty}>
                <Ionicons name="document-text-outline" size={22} color={colors.textMuted} />
                <Text style={styles.feedEmptyTxt}>
                  Aún no hay reportes capturados para este filtro.
                </Text>
              </View>
            ) : (
              <View style={{ gap: 10 }}>
                {filteredReports.slice(0, 20).map((r) => {
                  const when = r.created_at ? new Date(r.created_at) : null;
                  const hh = when ? when.toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' }) : '';
                  const pathLbl = (r.node_path_names || []).join(' › ') || (r as any).area_name || '—';
                  const author = (r as any).captured_by_name
                    || (r as any).user_name
                    || (r as any).author_name
                    || 'Especialista';
                  const valor = (r as any).avance ?? (r as any).medicion ?? '';
                  const thumb = (r as any).thumbnail_base64;
                  const photoUrl = (r as any).foto || (r as any).photo_url;
                  return (
                    <Pressable key={r.id} onPress={() => setPreviewItem(r)} style={({ pressed }) => [styles.feedCard, { flexDirection: 'row', gap: 10 }, pressed && { opacity: 0.85 }]}>
                      {thumb ? (
                        <Image
                          source={{ uri: `data:image/jpeg;base64,${thumb}` }}
                          style={{ width: 72, height: 72, borderRadius: 10, backgroundColor: '#f1f5f9' }}
                          resizeMode="cover"
                        />
                      ) : photoUrl ? (
                        <Image
                          source={{ uri: photoUrl }}
                          style={{ width: 72, height: 72, borderRadius: 10, backgroundColor: '#f1f5f9' }}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={{ width: 72, height: 72, borderRadius: 10, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' }}>
                          <Ionicons name="image-outline" size={24} color={colors.textMuted} />
                        </View>
                      )}
                      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
                        <View style={styles.feedRowTop}>
                          <Ionicons name="person-circle-outline" size={18} color={colors.primary} />
                          <Text style={styles.feedAuthor} numberOfLines={1}>{author}</Text>
                          <Text style={styles.feedDate} numberOfLines={1}>{hh}</Text>
                        </View>
                        <View style={styles.feedRowMid}>
                          <Ionicons name="git-branch-outline" size={14} color={colors.textMuted} />
                          <Text style={styles.feedPath} numberOfLines={2}>{pathLbl}</Text>
                        </View>
                        {!!valor && (
                          <View style={styles.feedRowVal}>
                            <Ionicons name="speedometer-outline" size={14} color={colors.success} />
                            <Text style={styles.feedVal}>{String(valor)}</Text>
                          </View>
                        )}
                        {!!r.comment && (
                          <Text style={styles.feedComment} numberOfLines={3}>{r.comment}</Text>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
                {filteredReports.length > 20 && (
                  <Text style={styles.feedMore}>
                    + {filteredReports.length - 20} reportes más (usa los filtros para acotar)
                  </Text>
                )}
              </View>
            )}

            {/* ===== Archivos de Consulta ===== */}
            <Text style={styles.sectionTitle}>Archivos de consulta</Text>
            <View style={styles.refCard}>
              <Text style={styles.refHelp}>
                Sube documentos (Excel/CSV de nodos, PDF, Word) o planos visibles para todo el equipo. Si el archivo es Excel o CSV con coordenadas, se cargarán los nodos automáticamente. Máximo 20 MB por archivo.
              </Text>

              {(project.reference_files || []).length === 0 ? (
                <View style={styles.refEmpty}>
                  <Ionicons name="folder-open-outline" size={20} color={colors.textMuted} />
                  <Text style={styles.refEmptyTxt}>Aún no hay archivos compartidos.</Text>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  {(project.reference_files || []).map((f, idx) => {
                    const key = f.file_id || `${f.url}-${idx}`;
                    const opening = !!(f.file_id && refOpeningId === f.file_id);
                    const subtitle = f.file_id
                      ? [f.original_name || '', formatBytes(f.size)].filter(Boolean).join(' · ')
                      : f.url;
                    return (
                      <View key={key} style={styles.refItem}>
                        <Ionicons
                          name={f.file_id ? 'document-attach-outline' : 'link-outline'}
                          size={18}
                          color={colors.primary}
                        />
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.refItemName} numberOfLines={1}>{f.name}</Text>
                          {!!subtitle && (
                            <Text style={styles.refItemUrl} numberOfLines={1}>{subtitle}</Text>
                          )}
                        </View>
                        <Pressable
                          onPress={() => onOpenRefFile(f)}
                          hitSlop={6}
                          style={styles.refIconBtn}
                          disabled={opening || refBusy}
                          accessibilityLabel={`Abrir ${f.name}`}
                        >
                          {opening ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Ionicons
                              name={f.file_id ? 'cloud-download-outline' : 'open-outline'}
                              size={18}
                              color={colors.primary}
                            />
                          )}
                        </Pressable>
                        <Pressable
                          onPress={() => onRemoveRefFile(idx)}
                          hitSlop={6}
                          style={styles.refIconBtn}
                          disabled={refBusy}
                          accessibilityLabel={`Eliminar ${f.name}`}
                        >
                          <Ionicons name="trash-outline" size={18} color={colors.error} />
                        </Pressable>
                      </View>
                    );
                  })}
                </View>
              )}

              <Pressable
                onPress={onPickAndUploadFile}
                disabled={refBusy}
                style={({ pressed }) => [
                  styles.refAddBtn,
                  refBusy && { opacity: 0.85 },
                  pressed && !refBusy && { opacity: 0.85 },
                ]}
                accessibilityRole="button"
                accessibilityLabel="Seleccionar archivo para subir"
              >
                {refBusy ? (
                  <>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={styles.refAddBtnTxt} numberOfLines={1}>
                      {refUploadName ? `Subiendo ${refUploadName}…` : 'Subiendo archivo…'}
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                    <Text style={styles.refAddBtnTxt}>Seleccionar archivo</Text>
                  </>
                )}
              </Pressable>
              <Text style={styles.refHint}>
                Formatos: Excel (.xlsx, .xls), CSV, PDF, Word (.doc, .docx). Tamaño máximo 20 MB.
              </Text>
            </View>

            <Pressable onPress={onArchive} style={styles.archiveBtn}>
              <Ionicons name="archive-outline" size={16} color={colors.error} />
              <Text style={styles.archiveText}>Archivar proyecto</Text>
            </Pressable>
              </>
            )}
          </>
        )}
      </ScrollView>

      {/* ===== Modal Calendario Histórico (Sprint 2) ===== */}
      <HistoryCalendarModal
        visible={calendarOpen}
        reports={reports}
        onClose={() => setCalendarOpen(false)}
        selectedDate={null}
        onPickDate={() => setCalendarOpen(false)}
      />

      {/* ===== Modal de Exportación: Período → Formato ===== */}
      <Modal
        visible={exportOpen}
        animationType="slide"
        transparent
        onRequestClose={closeExportFlow}
      >
        <Pressable style={styles.exportBackdrop} onPress={closeExportFlow} />
        <View style={styles.exportSheet} pointerEvents="box-none">
          <View style={styles.exportSheetInner}>
            <View style={styles.exportHandle} />

            <View style={styles.exportHeader}>
              {exportStep === 'period' ? (
                <View style={styles.exportBack} />
              ) : (
                <Pressable
                  onPress={() => {
                    if (exportBusy) return;
                    if (exportStep === 'format') setExportStep('area');
                    else if (exportStep === 'area') setExportStep('period');
                  }}
                  hitSlop={10}
                  style={styles.exportBack}
                >
                  <Ionicons name="chevron-back" size={22} color={colors.text} />
                </Pressable>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.exportTitle}>
                  {exportStep === 'period'
                    ? 'Exportar Reportes'
                    : exportStep === 'area'
                    ? 'Filtrar por Área'
                    : 'Elegir formato'}
                </Text>
                <Text style={styles.exportSubtitle}>
                  {exportStep === 'period'
                    ? 'Paso 1 de 3 · Selecciona el período'
                    : exportStep === 'area'
                    ? `Paso 2 de 3 · Período: ${PERIOD_OPTIONS.find((p) => p.value === exportPeriod)?.label ?? ''}`
                    : `Paso 3 de 3 · ${exportAreaId ? exportAreas.find((a) => a.id === exportAreaId)?.name ?? 'Área' : 'Todas las áreas'}`}
                </Text>
              </View>
              <Pressable
                onPress={closeExportFlow}
                disabled={exportBusy}
                hitSlop={10}
                style={styles.exportBack}
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>

            <View style={styles.exportSteps}>
              <View style={[styles.exportStepDot, styles.exportStepDotActive]} />
              <View style={[styles.exportStepBar, (exportStep === 'area' || exportStep === 'format') && styles.exportStepBarActive]} />
              <View
                style={[
                  styles.exportStepDot,
                  (exportStep === 'area' || exportStep === 'format') && styles.exportStepDotActive,
                ]}
              />
              <View style={[styles.exportStepBar, exportStep === 'format' && styles.exportStepBarActive]} />
              <View
                style={[
                  styles.exportStepDot,
                  exportStep === 'format' && styles.exportStepDotActive,
                ]}
              />
            </View>

            {exportStep === 'period' ? (
              <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
                {PERIOD_OPTIONS.map((opt) => {
                  const active = exportPeriod === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => onPickPeriod(opt.value)}
                      style={({ pressed }) => [
                        styles.exportItem,
                        active && styles.exportItemActive,
                        pressed && { opacity: 0.85 },
                      ]}
                    >
                      <View style={[styles.exportItemIcon, { backgroundColor: '#EEF2FF' }]}>
                        <Ionicons name={opt.icon} size={20} color="#1E3A8A" />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.exportItemTitle}>{opt.label}</Text>
                        <Text style={styles.exportItemSub}>{opt.sub}</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                    </Pressable>
                  );
                })}
              </View>
            ) : exportStep === 'area' ? (
              <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
                <Pressable
                  onPress={() => onPickArea(null)}
                  style={({ pressed }) => [
                    styles.exportItem,
                    exportAreaId === null && styles.exportItemActive,
                    pressed && { opacity: 0.85 },
                  ]}
                >
                  <View style={[styles.exportItemIcon, { backgroundColor: '#EEF2FF' }]}>
                    <Ionicons name="apps-outline" size={20} color="#1E3A8A" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.exportItemTitle}>Todas las áreas</Text>
                    <Text style={styles.exportItemSub}>Incluye todos los reportes Importantes y Urgentes del proyecto</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                </Pressable>
                {exportAreas.length === 0 ? (
                  <Text style={[styles.exportBusyHint, { marginTop: 12 }]}>
                    Este proyecto aún no tiene áreas configuradas. Se exportarán todos los reportes.
                  </Text>
                ) : (
                  exportAreas.map((a) => (
                    <Pressable
                      key={a.id}
                      onPress={() => onPickArea(a.id)}
                      style={({ pressed }) => [
                        styles.exportItem,
                        exportAreaId === a.id && styles.exportItemActive,
                        pressed && { opacity: 0.85 },
                      ]}
                    >
                      <View
                        style={[
                          styles.exportItemIcon,
                          { backgroundColor: (a.color || '#1E3A8A') + '22' },
                        ]}
                      >
                        <Ionicons name="grid-outline" size={20} color={a.color || '#1E3A8A'} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.exportItemTitle}>{a.name}</Text>
                        <Text style={styles.exportItemSub}>Sólo reportes del área seleccionada</Text>
                      </View>
                      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
                    </Pressable>
                  ))
                )}
              </View>
            ) : (
              <View style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.md }}>
                {FORMAT_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt.value}
                    onPress={() => onPickFormat(opt.value)}
                    disabled={exportBusy}
                    style={({ pressed }) => [
                      styles.exportItem,
                      exportBusy && { opacity: 0.6 },
                      pressed && !exportBusy && { opacity: 0.85 },
                    ]}
                  >
                    <View style={[styles.exportItemIcon, { backgroundColor: `${opt.tint}1A` }]}>
                      <Ionicons name={opt.icon} size={20} color={opt.tint} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.exportItemTitle}>{opt.label}</Text>
                      <Text style={styles.exportItemSub}>{opt.sub}</Text>
                    </View>
                    {exportBusy ? (
                      <ActivityIndicator color={opt.tint} />
                    ) : (
                      <Ionicons name="download-outline" size={20} color={colors.textMuted} />
                    )}
                  </Pressable>
                ))}
                {exportBusy ? (
                  <Text style={styles.exportBusyHint}>
                    Generando archivo en el servidor… esto puede tardar unos segundos.
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* ===== Modal: Preview de Reporte (componente compartido) ===== */}
      <ReportPreviewSheet
        visible={!!previewItem}
        item={previewItem}
        onClose={() => setPreviewItem(null)}
      />

      {/* ===== Modal: Contrato y Catálogos (P0 Mega-Feature) ===== */}
      <Modal
        visible={catModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => !catSaving && setCatModalOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
          style={styles.exportBackdrop}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !catSaving && setCatModalOpen(false)} />
          <View style={[styles.exportSheet, styles.sheetSurface, { maxHeight: '85%' }]}>
            <View style={styles.exportHandle} />
            <View style={styles.exportHeader}>
              <View style={styles.exportBack} />
              <View style={{ flex: 1 }}>
                <Text style={styles.exportTitle}>Contrato y Catálogos</Text>
                <Text style={styles.exportSubtitle}>
                  Configura el objeto del contrato y las categorías que verán los especialistas al crear reportes.
                </Text>
              </View>
              <Pressable
                onPress={() => !catSaving && setCatModalOpen(false)}
                hitSlop={10}
                style={styles.exportBack}
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.md }}
            >
              <View>
                <Text style={styles.catLabel}>Categorías de personal</Text>
                <Text style={styles.catHelper}>
                  Roles disponibles al capturar un reporte (Topógrafo, Cadenero, Brigadista…).
                </Text>
                <View style={styles.catChipsWrap}>
                  {catPersonalList.map((it, idx) => (
                    <View key={`${it}-${idx}`} style={styles.catChip}>
                      <Text style={styles.catChipTxt}>{it}</Text>
                      <Pressable
                        onPress={() => setCatPersonalList((arr) => arr.filter((x) => x !== it))}
                        hitSlop={6}
                      >
                        <Ionicons name="close" size={14} color="#1E3A8A" />
                      </Pressable>
                    </View>
                  ))}
                  {catPersonalList.length === 0 && (
                    <Text style={styles.catEmpty}>Aún no hay categorías; agrega una abajo.</Text>
                  )}
                </View>
                <View style={styles.catInputRow}>
                  <TextInput
                    value={catPersonalDraft}
                    onChangeText={setCatPersonalDraft}
                    onSubmitEditing={addCatPersonal}
                    placeholder="Nueva categoría de personal"
                    placeholderTextColor={colors.textMuted}
                    style={styles.catInput}
                    returnKeyType="done"
                  />
                  <Pressable onPress={addCatPersonal} style={styles.catAddBtn}>
                    <Ionicons name="add" size={20} color="#fff" />
                  </Pressable>
                </View>
              </View>

              <View>
                <Text style={styles.catLabel}>Categorías de equipo</Text>
                <Text style={styles.catHelper}>
                  Equipo disponible al capturar un reporte (Estación total, GPS RTK, Nivel…).
                </Text>
                <View style={styles.catChipsWrap}>
                  {catEquipoList.map((it, idx) => (
                    <View key={`${it}-${idx}`} style={styles.catChip}>
                      <Text style={styles.catChipTxt}>{it}</Text>
                      <Pressable
                        onPress={() => setCatEquipoList((arr) => arr.filter((x) => x !== it))}
                        hitSlop={6}
                      >
                        <Ionicons name="close" size={14} color="#1E3A8A" />
                      </Pressable>
                    </View>
                  ))}
                  {catEquipoList.length === 0 && (
                    <Text style={styles.catEmpty}>Aún no hay categorías; agrega una abajo.</Text>
                  )}
                </View>
                <View style={styles.catInputRow}>
                  <TextInput
                    value={catEquipoDraft}
                    onChangeText={setCatEquipoDraft}
                    onSubmitEditing={addCatEquipo}
                    placeholder="Nueva categoría de equipo"
                    placeholderTextColor={colors.textMuted}
                    style={styles.catInput}
                    returnKeyType="done"
                  />
                  <Pressable onPress={addCatEquipo} style={styles.catAddBtn}>
                    <Ionicons name="add" size={20} color="#fff" />
                  </Pressable>
                </View>
              </View>

              <Pressable
                onPress={saveCatalogos}
                disabled={catSaving}
                style={({ pressed }) => [
                  styles.catSaveBtn,
                  catSaving && { opacity: 0.6 },
                  pressed && !catSaving && { opacity: 0.9 },
                ]}
              >
                {catSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={18} color="#fff" />
                    <Text style={styles.catSaveTxt}>Guardar configuración</Text>
                  </>
                )}
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ===== Modal: Identidad institucional (objeto + cliente + color) ===== */}
      <Modal
        visible={objetoModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => !objetoSaving && setObjetoModalOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 24}
          style={styles.exportBackdrop}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => !objetoSaving && setObjetoModalOpen(false)}
          />
          <View style={[styles.exportSheet, styles.sheetSurface, { maxHeight: '88%' }]}>
            <View style={styles.exportHandle} />
            <View style={styles.exportHeader}>
              <View style={styles.exportBack} />
              <View style={{ flex: 1 }}>
                <Text style={styles.exportTitle}>Identidad institucional</Text>
                <Text style={styles.exportSubtitle}>
                  Estos datos aparecen en las portadas y encabezados de los reportes exportados (PDF, Word, PowerPoint).
                </Text>
              </View>
              <Pressable
                onPress={() => !objetoSaving && setObjetoModalOpen(false)}
                hitSlop={10}
                style={styles.exportBack}
              >
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.md }}
            >
              <View>
                <Text style={styles.catLabel}>Cliente principal</Text>
                <Text style={styles.catHelper}>
                  Dependencia o entidad que contrata la obra (aparece como "CLIENTE" en la portada).
                </Text>
                <TextInput
                  value={clienteDraft}
                  onChangeText={setClienteDraft}
                  placeholder="Ej. Gobierno de la Ciudad de México - SOBSE"
                  placeholderTextColor={colors.textMuted}
                  style={styles.catInput}
                />
              </View>

              <View>
                <Text style={styles.catLabel}>Color institucional (#RRGGBB)</Text>
                <Text style={styles.catHelper}>
                  Color principal usado en banners, portadas y subtítulos de los reportes.
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <TextInput
                    value={colorDraft}
                    onChangeText={setColorDraft}
                    placeholder="#003366"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="characters"
                    style={[styles.catInput, { flex: 1 }]}
                  />
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: radius.sm,
                      borderWidth: 1,
                      borderColor: colors.borderStrong,
                      backgroundColor: /^#([0-9a-fA-F]{3}){1,2}$/.test((colorDraft || '').trim())
                        ? colorDraft.trim()
                        : '#003366',
                    }}
                  />
                </View>
              </View>

              <View>
                <Text style={styles.catLabel}>Objeto del contrato</Text>
                <Text style={styles.catHelper}>
                  Descripción institucional del alcance del contrato (aparece en la portada como descripción de la obra).
                </Text>
                <TextInput
                  value={objetoDraft}
                  onChangeText={setObjetoDraft}
                  placeholder="Ej. Supervisión técnica de la construcción del Tramo III…"
                  placeholderTextColor={colors.textMuted}
                  multiline
                  style={[styles.catInput, { minHeight: 90, textAlignVertical: 'top', paddingTop: 10 }]}
                />
              </View>

              <Pressable
                onPress={saveObjeto}
                disabled={objetoSaving}
                style={({ pressed }) => [
                  styles.catSaveBtn,
                  objetoSaving && { opacity: 0.7 },
                  pressed && !objetoSaving && { opacity: 0.85 },
                ]}
              >
                {objetoSaving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={18} color="#fff" />
                    <Text style={styles.catSaveTxt}>Guardar identidad</Text>
                  </>
                )}
              </Pressable>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ===== Modal: Plantillas de exportación (PDF/DOCX/PPTX) ===== */}
      <Modal
        visible={tplModalOpen}
        animationType="slide"
        transparent
        onRequestClose={() => !tplBusyKind && setTplModalOpen(false)}
      >
        <Pressable
          style={styles.exportBackdrop}
          onPress={() => !tplBusyKind && setTplModalOpen(false)}
        />
        <View style={[styles.exportSheet, styles.sheetSurface, { maxHeight: '88%' }]}>
          <View style={styles.exportHandle} />
          <View style={styles.exportHeader}>
            <View style={styles.exportBack} />
            <View style={{ flex: 1 }}>
              <Text style={styles.exportTitle}>Plantillas de exportación</Text>
              <Text style={styles.exportSubtitle}>
                Sube fondos institucionales que se imprimirán como base al exportar reportes.
              </Text>
            </View>
            <Pressable
              onPress={() => !tplBusyKind && setTplModalOpen(false)}
              hitSlop={10}
              style={styles.exportBack}
            >
              <Ionicons name="close" size={22} color={colors.text} />
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.lg, gap: spacing.md }}
          >
            <View style={styles.tplHelperBox}>
              <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.tplHelperTxt}>
                El motor imprime datos, tablas y fotos sobre tu plantilla. Deja márgenes amplios en tu diseño. Si no subes plantilla, se usa el diseño DIRAC por defecto. Máx. 25 MB por archivo.
              </Text>
            </View>

            {(['pdf', 'docx', 'pptx'] as const).map((kind) => {
              const meta =
                kind === 'pdf'
                  ? { label: 'PDF', sub: 'Fondo para reportes horizontales (letter)', icon: 'document-text' as const, tint: '#DC2626' }
                  : kind === 'docx'
                  ? { label: 'Word', sub: 'Plantilla base para el documento editable', icon: 'document' as const, tint: '#1D4ED8' }
                  : { label: 'PowerPoint', sub: 'Máster base para presentación 16:9', icon: 'easel' as const, tint: '#B45309' };
              const hasFile = !!(project as any)?.[`template_${kind}`];
              const busy = tplBusyKind === kind;
              return (
                <View key={kind} style={styles.tplCard}>
                  <View style={styles.tplCardTop}>
                    <View style={[styles.exportItemIcon, { backgroundColor: `${meta.tint}1A` }]}>
                      <Ionicons name={meta.icon} size={22} color={meta.tint} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.tplCardTitle}>{meta.label}</Text>
                      <Text style={styles.tplCardSub}>{meta.sub}</Text>
                      <View style={styles.tplStatusRow}>
                        <View
                          style={[
                            styles.tplStatusDot,
                            { backgroundColor: hasFile ? colors.success : colors.textMuted },
                          ]}
                        />
                        <Text
                          style={[
                            styles.tplStatusTxt,
                            { color: hasFile ? colors.success : colors.textMuted },
                          ]}
                        >
                          {hasFile ? 'Plantilla cargada' : 'Sin plantilla (diseño DIRAC)'}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <View style={styles.tplBtnRow}>
                    <Pressable
                      onPress={() => onPickAndUploadTemplate(kind)}
                      disabled={!!tplBusyKind}
                      style={({ pressed }) => [
                        styles.tplPrimaryBtn,
                        { backgroundColor: meta.tint },
                        !!tplBusyKind && { opacity: 0.55 },
                        pressed && !tplBusyKind && { opacity: 0.85 },
                      ]}
                    >
                      {busy ? (
                        <ActivityIndicator color="#fff" size="small" />
                      ) : (
                        <>
                          <Ionicons
                            name={hasFile ? 'refresh-outline' : 'cloud-upload-outline'}
                            size={16}
                            color="#fff"
                          />
                          <Text style={styles.tplPrimaryTxt}>
                            {hasFile ? 'Reemplazar' : 'Subir plantilla'}
                          </Text>
                        </>
                      )}
                    </Pressable>
                    {hasFile && (
                      <Pressable
                        onPress={() => onDeleteTemplate(kind)}
                        disabled={!!tplBusyKind}
                        style={({ pressed }) => [
                          styles.tplGhostBtn,
                          !!tplBusyKind && { opacity: 0.55 },
                          pressed && !tplBusyKind && { opacity: 0.85 },
                        ]}
                      >
                        <Ionicons name="trash-outline" size={16} color={colors.error} />
                        <Text style={styles.tplGhostTxt}>Eliminar</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function InfoRow({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

function ActionTile({ icon, title, subtitle, disabled, comingSoon, onPress, busy }: any) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!!disabled}
      style={({ pressed }) => [styles.tile, disabled && { opacity: 0.55 }, pressed && !disabled && { transform: [{ scale: 0.99 }] }]}
    >
      <View style={styles.tileIcon}>
        {busy ? <ActivityIndicator color={colors.primary} /> : <Ionicons name={icon} size={20} color={colors.primary} />}
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.tileTitle}>{title}</Text>
          {comingSoon ? <Text style={styles.soonBadge}>Próximamente</Text> : null}
        </View>
        <Text style={styles.tileSub}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  // ===== Tabs (Detalle / Resumen IA) =====
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: 'transparent',
  },
  tabBtnActive: {
    backgroundColor: colors.primary,
    ...shadow.sm,
  },
  tabTxt: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  tabTxtActive: {
    color: '#fff',
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, gap: spacing.md,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800', color: colors.text },
  scroll: { paddingHorizontal: spacing.lg, gap: spacing.md },
  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.errorBg, padding: 10, borderRadius: radius.md },
  errorText: { flex: 1, color: colors.error, fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
  rowLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  rowValue: { fontSize: 14, color: colors.text, fontWeight: '700' },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: colors.textBody, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.sm },
  tile: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  tileIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.primaryLight, alignItems: 'center', justifyContent: 'center' },
  tileTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  tileSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  soonBadge: { fontSize: 9, fontWeight: '800', color: colors.primary, backgroundColor: colors.primaryLight, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  archiveBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, padding: spacing.md, marginTop: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.errorBg },
  archiveText: { color: colors.error, fontSize: 13, fontWeight: '700' },

  // Botón grande Calendario
  calendarBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },

  // Archivos de Consulta
  refCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  refHelp: { fontSize: 12, color: colors.textMuted, lineHeight: 17 },
  refEmpty: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 12,
    backgroundColor: colors.bg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  refEmptyTxt: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  refItem: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8, paddingHorizontal: 10,
    backgroundColor: colors.bg, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
  },
  refItemName: { fontSize: 13, fontWeight: '700', color: colors.text },
  refItemUrl: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  refIconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  refAddBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 12,
    borderRadius: radius.md, minHeight: 48, marginTop: 4,
  },
  refAddBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '800', flexShrink: 1 },
  refHint: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 2 },

  // === Exportación (Botón + Modal en 2 pasos) ================================
  exportMainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
    borderRadius: radius.lg,
    minHeight: 64,
    ...shadow.card,
  },
  exportMainTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  exportMainSub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },

  exportBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15,23,42,0.45)',
  },
  exportSheet: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  sheetSurface: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: undefined,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: (radius as any).xl ?? 20,
    borderTopRightRadius: (radius as any).xl ?? 20,
    paddingTop: 10,
    paddingBottom: 24,
    ...shadow.card,
  },
  exportSheetInner: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: (radius as any).xl ?? 20,
    borderTopRightRadius: (radius as any).xl ?? 20,
    paddingTop: 10,
    paddingBottom: 24,
    ...shadow.card,
  },
  exportHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 8,
  },
  exportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: 4,
    gap: 6,
  },
  exportBack: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: (radius as any).full ?? 999,
  },
  exportTitle: { fontSize: 17, fontWeight: '800', color: colors.text },
  exportSubtitle: { fontSize: 12, color: colors.textMuted, fontWeight: '600', marginTop: 2 },

  exportSteps: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: spacing.sm,
  },
  exportStepDot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: colors.border,
  },
  exportStepDotActive: { backgroundColor: colors.primary },
  exportStepBar: {
    width: 48, height: 3, borderRadius: 2,
    backgroundColor: colors.border,
  },
  exportStepBarActive: { backgroundColor: colors.primary },

  exportItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    marginTop: spacing.sm,
    minHeight: 64,
  },
  exportItemActive: {
    borderColor: colors.primary,
    backgroundColor: '#EEF2FF',
  },
  exportItemIcon: {
    width: 40, height: 40, borderRadius: (radius as any).full ?? 999,
    alignItems: 'center', justifyContent: 'center',
  },
  exportItemTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  exportItemSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  exportBusyHint: {
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
    fontStyle: 'italic',
  },

  // === Botón IA · Resumen Ejecutivo =========================================
  aiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#7C3AED',
    paddingHorizontal: spacing.md,
    paddingVertical: 16,
    borderRadius: radius.lg,
    minHeight: 64,
    ...shadow.card,
  },
  aiBtnTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  aiBtnSub: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },

  // === Filtro de tramos / áreas (chips horizontales) ========================
  chipWrap: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    gap: 8,
  },
  chipTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 4,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingRight: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    minHeight: 36,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.text,
  },
  chipTextActive: {
    color: '#fff',
  },

  // ===== Feed de Reportes =====
  feedEmpty: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 12, paddingHorizontal: 12,
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
  },
  feedEmptyTxt: { flex: 1, color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  feedCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    gap: 6,
  },
  feedRowTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  feedAuthor: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.text },
  feedDate: { fontSize: 11, fontWeight: '600', color: colors.textMuted },
  feedRowMid: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  feedPath: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.textBody },
  feedRowVal: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  feedVal: { fontSize: 13, fontWeight: '800', color: colors.success },
  feedComment: { fontSize: 12, color: colors.textBody, lineHeight: 17, fontStyle: 'italic' },
  feedMore: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 4, fontStyle: 'italic' },

  // ===== Preview Modal (tap en feed) =====
  previewBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  previewCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.surface,
    borderRadius: (radius as any).xl ?? 16,
    overflow: 'hidden',
    ...shadow.card,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 12,
  },
  previewTitle: { flex: 1, fontSize: 15, fontWeight: '800', color: colors.text },
  previewRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewMeta: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.textBody },
  previewBlock: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: 10,
    gap: 4,
  },
  previewBlockTitle: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  previewBlockTxt: { fontSize: 13, color: colors.text, lineHeight: 18 },
  previewFooter: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  previewCloseBtn: {
    minHeight: 44,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.md,
  },
  previewCloseTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },

  // ===== Estilos del modal Contrato y Catálogos (P0 Mega-Feature) =====
  catLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.text,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  catHelper: {
    fontSize: 12,
    color: colors.textMuted,
    marginBottom: 8,
  },
  catTextArea: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 80,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: 14,
  },
  catCounter: {
    marginTop: 4,
    fontSize: 11,
    color: colors.textMuted,
    textAlign: 'right',
  },
  catChipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingVertical: 6,
    minHeight: 30,
  },
  catChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  catChipTxt: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1E3A8A',
  },
  catEmpty: {
    fontSize: 12,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  catInputRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  catInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.surface,
    fontSize: 14,
  },
  catAddBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  catSaveBtn: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: radius.md,
  },
  catSaveTxt: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },

  // ===== Estilos: Modal de Plantillas de Exportación (P0) =====
  tplHelperBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#EEF2FF',
    borderWidth: 1,
    borderColor: '#C7D2FE',
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tplHelperTxt: {
    flex: 1,
    fontSize: 12,
    color: '#1E3A8A',
    lineHeight: 17,
    fontWeight: '600',
  },
  tplCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 12,
    gap: 10,
  },
  tplCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  tplCardTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.text,
  },
  tplCardSub: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  tplStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  tplStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tplStatusTxt: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  tplBtnRow: {
    flexDirection: 'row',
    gap: 8,
  },
  tplPrimaryBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.md,
    minHeight: 44,
  },
  tplPrimaryTxt: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
  },
  tplGhostBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error,
    backgroundColor: colors.surface,
    minHeight: 44,
  },
  tplGhostTxt: {
    color: colors.error,
    fontSize: 13,
    fontWeight: '800',
  },
});
