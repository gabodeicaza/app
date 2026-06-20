import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, Alert, Platform,
  TextInput, Linking, Modal, Image,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
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

// === Flujo de Exportación en 2 pasos ====================================
type ExportFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx';
type ExportStep = 'period' | 'format';

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

  // Exportación unificada (2 pasos: período → formato)
  const [exportOpen, setExportOpen] = useState(false);
  const [exportStep, setExportStep] = useState<ExportStep>('period');
  const [exportPeriod, setExportPeriod] = useState<ReportPeriod>('today');
  const [exportBusy, setExportBusy] = useState(false);

  // Preview de reporte (tap en feed)
  const [previewItem, setPreviewItem] = useState<FeedItem | null>(null);

  // Archivos de Consulta (Reference Files)
  const [refName, setRefName] = useState('');
  const [refUrl, setRefUrl] = useState('');
  const [refBusy, setRefBusy] = useState(false);

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

  async function onAddRefFile() {
    const name = refName.trim();
    const url = refUrl.trim();
    if (!name || !url) {
      Alert.alert('Datos incompletos', 'Indica un nombre y una URL para el archivo.');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      Alert.alert('URL inválida', 'La URL debe comenzar con http:// o https://');
      return;
    }
    const current = project?.reference_files || [];
    const next: ReferenceFile[] = [...current, { name, url }];
    await persistRefs(next);
    setRefName('');
    setRefUrl('');
  }

  async function onRemoveRefFile(idx: number) {
    const ok = await confirm(
      'Eliminar archivo',
      '¿Quitar este archivo de consulta del proyecto?',
      { confirmText: 'Eliminar', destructive: true },
    );
    if (!ok) return;
    const current = project?.reference_files || [];
    const next = current.filter((_, i) => i !== idx);
    await persistRefs(next);
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

  // === Exportación: flujo en 2 pasos =========================================
  function openExportFlow() {
    setExportStep('period');
    setExportPeriod('today');
    setExportOpen(true);
  }

  function closeExportFlow() {
    if (exportBusy) return;
    setExportOpen(false);
    setTimeout(() => setExportStep('period'), 200);
  }

  function onPickPeriod(p: ReportPeriod) {
    setExportPeriod(p);
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
              dialogTitle: 'Compartir reporte SynCo',
            });
          } else {
            Alert.alert('Listo', `Archivo guardado en caché:\n${dest}`);
          }
        }
      } else {
        let blob: Blob; let filename: string; let mime: string;
        if (fmt === 'docx') {
          const r = await api.downloadReportsDocx(pid, exportPeriod);
          blob = r.blob; filename = r.filename;
          mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else if (fmt === 'pptx') {
          const r = await api.downloadReportsPptx(pid, exportPeriod);
          blob = r.blob; filename = r.filename;
          mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        } else {
          const r = await api.downloadReportsPdf(pid, exportPeriod);
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
                Comparte enlaces a documentos (planos, especificaciones, manuales, etc.) visibles para todos los Especialistas.
              </Text>

              {(project.reference_files || []).length === 0 ? (
                <View style={styles.refEmpty}>
                  <Ionicons name="folder-open-outline" size={20} color={colors.textMuted} />
                  <Text style={styles.refEmptyTxt}>Aún no hay archivos compartidos.</Text>
                </View>
              ) : (
                <View style={{ gap: 8 }}>
                  {(project.reference_files || []).map((f, idx) => (
                    <View key={`${f.url}-${idx}`} style={styles.refItem}>
                      <Ionicons name="document-text-outline" size={18} color={colors.primary} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.refItemName} numberOfLines={1}>{f.name}</Text>
                        <Text style={styles.refItemUrl} numberOfLines={1}>{f.url}</Text>
                      </View>
                      <Pressable
                        onPress={() => Linking.openURL(f.url).catch(() => Alert.alert('No se pudo abrir', 'Revisa la URL.'))}
                        hitSlop={6}
                        style={styles.refIconBtn}
                      >
                        <Ionicons name="open-outline" size={18} color={colors.primary} />
                      </Pressable>
                      <Pressable
                        onPress={() => onRemoveRefFile(idx)}
                        hitSlop={6}
                        style={styles.refIconBtn}
                        disabled={refBusy}
                      >
                        <Ionicons name="trash-outline" size={18} color={colors.error} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.refForm}>
                <TextInput
                  value={refName}
                  onChangeText={setRefName}
                  placeholder="Nombre del documento"
                  placeholderTextColor={colors.textMuted}
                  style={styles.refInput}
                  editable={!refBusy}
                />
                <TextInput
                  value={refUrl}
                  onChangeText={setRefUrl}
                  placeholder="https://…"
                  placeholderTextColor={colors.textMuted}
                  style={styles.refInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!refBusy}
                />
                <Pressable
                  onPress={onAddRefFile}
                  disabled={refBusy}
                  style={({ pressed }) => [styles.refAddBtn, refBusy && { opacity: 0.6 }, pressed && !refBusy && { opacity: 0.85 }]}
                >
                  {refBusy ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="add-circle-outline" size={18} color="#fff" />
                      <Text style={styles.refAddBtnTxt}>Agregar archivo</Text>
                    </>
                  )}
                </Pressable>
              </View>
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
              {exportStep === 'format' ? (
                <Pressable
                  onPress={() => !exportBusy && setExportStep('period')}
                  hitSlop={10}
                  style={styles.exportBack}
                >
                  <Ionicons name="chevron-back" size={22} color={colors.text} />
                </Pressable>
              ) : (
                <View style={styles.exportBack} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.exportTitle}>
                  {exportStep === 'period' ? 'Exportar Reportes' : 'Elegir formato'}
                </Text>
                <Text style={styles.exportSubtitle}>
                  {exportStep === 'period'
                    ? 'Paso 1 de 2 · Selecciona el período'
                    : `Paso 2 de 2 · Período: ${PERIOD_OPTIONS.find((p) => p.value === exportPeriod)?.label ?? ''}`}
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

      {/* ===== Modal: Preview de Reporte ===== */}
      <Modal
        visible={!!previewItem}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewItem(null)}
      >
        <Pressable style={styles.previewBackdrop} onPress={() => setPreviewItem(null)}>
          <Pressable style={styles.previewCard} onPress={(e) => e.stopPropagation()}>
            <View style={styles.previewHeader}>
              <Text style={styles.previewTitle} numberOfLines={1}>
                {(previewItem?.node_path_names || []).slice(-1)[0] || 'Reporte'}
              </Text>
              <Pressable hitSlop={10} onPress={() => setPreviewItem(null)}>
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ padding: 16, gap: 12 }}>
              {previewItem?.thumbnail_base64 ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${previewItem.thumbnail_base64}` }}
                  style={{ width: '100%', height: 200, borderRadius: 8 }}
                  resizeMode="cover"
                />
              ) : ((previewItem as any)?.foto || (previewItem as any)?.photo_url) ? (
                <Image
                  source={{ uri: (previewItem as any).foto || (previewItem as any).photo_url }}
                  style={{ width: '100%', height: 200, borderRadius: 8 }}
                  resizeMode="cover"
                />
              ) : null}
              <View style={styles.previewRow}>
                <Ionicons name="person-outline" size={16} color={colors.textMuted} />
                <Text style={styles.previewMeta} numberOfLines={2}>
                  {(previewItem as any)?.captured_by_name
                    || (previewItem as any)?.user_name
                    || (previewItem as any)?.author_name
                    || 'Especialista'}
                </Text>
              </View>
              <View style={styles.previewRow}>
                <Ionicons name="grid-outline" size={16} color={colors.textMuted} />
                <Text style={styles.previewMeta} numberOfLines={2}>
                  {(previewItem as any)?.area_name || 'Sin área asignada'}
                </Text>
              </View>
              <View style={styles.previewRow}>
                <Ionicons name="location-outline" size={16} color={colors.textMuted} />
                <Text style={styles.previewMeta} numberOfLines={3}>
                  {(previewItem?.node_path_names || []).join(' › ') || (previewItem as any)?.area_name || '—'}
                </Text>
              </View>
              <View style={styles.previewRow}>
                <Ionicons name="time-outline" size={16} color={colors.textMuted} />
                <Text style={styles.previewMeta}>
                  {previewItem?.created_at
                    ? new Date(previewItem.created_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' })
                    : '—'}
                </Text>
              </View>
              {((previewItem as any)?.avance || (previewItem as any)?.medicion) ? (
                <View style={styles.previewBlock}>
                  <Text style={styles.previewBlockTitle}>Avance / Medición</Text>
                  <Text style={styles.previewBlockTxt}>
                    {String((previewItem as any)?.avance ?? (previewItem as any)?.medicion ?? '')}
                  </Text>
                </View>
              ) : null}
              <View style={styles.previewBlock}>
                <Text style={styles.previewBlockTitle}>Observaciones</Text>
                <Text
                  style={[
                    styles.previewBlockTxt,
                    !(
                      (previewItem as any)?.notes
                      || (previewItem as any)?.observaciones
                    ) && { fontStyle: 'italic', color: colors.textMuted },
                  ]}
                >
                  {(previewItem as any)?.notes
                    || (previewItem as any)?.observaciones
                    || 'Sin observaciones'}
                </Text>
              </View>
              {previewItem?.comment ? (
                <View style={styles.previewBlock}>
                  <Text style={styles.previewBlockTitle}>Comentario</Text>
                  <Text style={styles.previewBlockTxt}>{previewItem.comment}</Text>
                </View>
              ) : null}
            </ScrollView>
            <View style={styles.previewFooter}>
              <Pressable
                onPress={() => setPreviewItem(null)}
                style={({ pressed }) => [styles.previewCloseBtn, pressed && { opacity: 0.85 }]}
              >
                <Text style={styles.previewCloseTxt}>Cerrar</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
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
  refForm: { gap: 8, marginTop: 4 },
  refInput: {
    minHeight: 44,
    paddingHorizontal: 12, paddingVertical: 10,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    backgroundColor: colors.bg, color: colors.text, fontSize: 14,
  },
  refAddBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: colors.primary, paddingVertical: 12, borderRadius: radius.md, minHeight: 44,
  },
  refAddBtnTxt: { color: '#fff', fontSize: 14, fontWeight: '800' },

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
});
