import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, Alert, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api, Project } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';

export default function ProjectDetailScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = (Array.isArray(id) ? id[0] : id) || '';
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

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

            <Pressable onPress={onArchive} style={styles.archiveBtn}>
              <Ionicons name="archive-outline" size={16} color={colors.error} />
              <Text style={styles.archiveText}>Archivar proyecto</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
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
});
