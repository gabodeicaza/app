import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, Alert, Platform, TextInput, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api, Project, ReferenceFile } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';
import { PeriodSheet, ReportPeriod } from '@/src/components/PeriodSheet';
import { downloadBlob } from '@/src/utils/downloadBlob';

export default function ProjectDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = (Array.isArray(id) ? id[0] : id) || '';
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [pdfSheetOpen, setPdfSheetOpen] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);

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

  useFocusEffect(useCallback(() => { load(); }, [load]));

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

  async function onExportXlsx() {
    try {
      setExporting(true);
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
        // Expo SDK 54: writeAsStringAsync se movió al paquete legacy.
        const FileSystem: any = await import('expo-file-system/legacy');
        const Sharing: any = await import('expo-sharing');
        const dest = `${FileSystem.cacheDirectory || ''}${filename}`;
        await FileSystem.writeAsStringAsync(dest, base64, { encoding: FileSystem.EncodingType?.Base64 || 'base64' });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(dest, { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', dialogTitle: 'Compartir reporte SynCo' });
        } else {
          Alert.alert('Listo', `Archivo guardado en caché:\n${dest}`);
        }
      }
    } catch (e: any) {
      Alert.alert('Error al exportar', e?.message || 'No se pudo generar el Excel');
    } finally {
      setExporting(false);
    }
  }

  async function onPickPdfPeriod(period: ReportPeriod) {
    setPdfSheetOpen(false);
    try {
      setExportingPdf(true);
      const { blob, filename } = await api.downloadReportsPdf(pid, period);
      await downloadBlob(blob, filename, 'application/pdf');
    } catch (e: any) {
      Alert.alert('Error al exportar', e?.message || 'No se pudo generar el PDF');
    } finally {
      setExportingPdf(false);
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
              title="Calendario"
              subtitle="Programa eventos, visitas e hitos del proyecto"
              onPress={() => router.push({ pathname: '/(coord)/projects/[id]/events' as any, params: { id: pid } })}
            />
            <ActionTile
              icon="document-text-outline"
              title={exporting ? 'Generando Excel…' : 'Exportar reportes a Excel'}
              subtitle="Sábana plana ordenada por jerarquía del árbol (incluye coords X/Y/Z)"
              onPress={onExportXlsx}
              disabled={exporting}
              busy={exporting}
            />
            <ActionTile
              icon="document-attach-outline"
              title={exportingPdf ? 'Generando PDF…' : 'Exportar reportes a PDF'}
              subtitle="PDF horizontal con jerarquía completa (Hoy · Ayer · Semana · Mes)"
              onPress={() => setPdfSheetOpen(true)}
              disabled={exportingPdf}
              busy={exportingPdf}
            />

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
      </ScrollView>
      <PeriodSheet
        visible={pdfSheetOpen}
        title="Selecciona el período"
        onClose={() => setPdfSheetOpen(false)}
        onSelect={onPickPdfPeriod}
      />
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
});
