// Dashboard de Sub-coordinador (Fase 4)
// Vista de lectura con:
//   - Resumen Ejecutivo (% avance global del proyecto)
//   - Alertas Semáforo (nodos con avance < 50%)
//   - Feed de Reportes Recientes (del día)
//   - Exportar Reportes (XLSX)
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/src/auth-context';
import { api, FeedItem, LocationNode, Project } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { roleLabel } from '@/src/utils/roles';
import { confirm } from '@/src/utils/confirm';

type ProgressRow = {
  node: LocationNode;
  count: number;
  pct: number; // 0..100
};

export default function SubCoordDashboard() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  const [projects, setProjects] = useState<Project[]>([]);
  const [pid, setPid] = useState<string | null>(null);
  const [nodes, setNodes] = useState<LocationNode[]>([]);
  const [reports, setReports] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list || []);
      if ((list || []).length > 0 && !pid) {
        setPid(list[0].id);
      }
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar los proyectos');
    }
  }, [pid]);

  const loadData = useCallback(async (projectId: string) => {
    try {
      setError(null);
      const [ns, feed] = await Promise.all([
        api.listNodes(projectId),
        api.feed(projectId, 'today', 100),
      ]);
      setNodes(ns || []);
      setReports(feed?.reports || []);
    } catch (e: any) {
      setError(e?.message || 'No se pudo cargar la información');
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadProjects();
      setLoading(false);
    })();
  }, [loadProjects]);

  useEffect(() => {
    if (!pid) return;
    (async () => {
      setLoading(true);
      await loadData(pid);
      setLoading(false);
    })();
  }, [pid, loadData]);

  const onRefresh = useCallback(async () => {
    if (!pid) return;
    setRefreshing(true);
    await loadData(pid);
    setRefreshing(false);
  }, [pid, loadData]);

  const progressRows: ProgressRow[] = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of reports) {
      counts.set(r.node_id, (counts.get(r.node_id) || 0) + 1);
    }
    const rows: ProgressRow[] = [];
    for (const n of nodes) {
      if (typeof n.meta === 'number' && (n.meta || 0) > 0) {
        const count = counts.get(n.id) || 0;
        const pct = Math.min(100, Math.round((count / (n.meta || 1)) * 100));
        rows.push({ node: n, count, pct });
      }
    }
    return rows;
  }, [nodes, reports]);

  const globalPct = useMemo(() => {
    if (progressRows.length === 0) return 0;
    const sum = progressRows.reduce((acc, r) => acc + r.pct, 0);
    return Math.round(sum / progressRows.length);
  }, [progressRows]);

  const alerts = useMemo(
    () => progressRows.filter((r) => r.pct < 50).sort((a, b) => a.pct - b.pct),
    [progressRows],
  );

  const todayReports = useMemo(
    () => [...reports].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 12),
    [reports],
  );

  async function onLogout() {
    const ok = await confirm('Cerrar sesión', '¿Seguro que deseas salir?', {
      confirmText: 'Salir',
      destructive: true,
    });
    if (!ok) return;
    await logout();
    router.replace('/(auth)/login');
  }

  async function onExport() {
    if (!pid || exporting) return;
    try {
      setExporting(true);
      const { blob, filename } = await api.downloadReportsXlsx(pid);
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } else {
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
        await FileSystem.writeAsStringAsync(dest, base64, {
          encoding: FileSystem.EncodingType?.Base64 || 'base64',
        });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(dest, {
            mimeType:
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            dialogTitle: 'Compartir reporte SynCo',
          });
        } else {
          Alert.alert('Listo', `Archivo guardado en caché:\n${dest}`);
        }
      }
    } catch (e: any) {
      Alert.alert(
        'No se pudo exportar',
        e?.message || 'Inténtalo nuevamente.',
      );
    } finally {
      setExporting(false);
    }
  }

  function progressTint(pct: number) {
    if (pct >= 100) return colors.success;
    if (pct >= 50) return colors.primary;
    return colors.error;
  }

  function formatTime(iso: string) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  const currentProject = projects.find((p) => p.id === pid);

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.brand}>SynCo</Text>
          <Text style={styles.role}>Sub-coordinador · {roleLabel(user?.role)}</Text>
        </View>
        <Pressable onPress={onLogout} hitSlop={8} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={22} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        <Text style={styles.greeting}>Hola, {user?.name}</Text>

        {/* Selector de proyecto */}
        {projects.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.projRow}
          >
            {projects.map((p) => {
              const sel = p.id === pid;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => setPid(p.id)}
                  style={[styles.projChip, sel && styles.projChipSel]}
                >
                  <Text style={[styles.projChipTxt, sel && styles.projChipTxtSel]} numberOfLines={1}>
                    {p.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {!!currentProject && (
          <Text style={styles.projTitle} numberOfLines={1}>
            {currentProject.name}
          </Text>
        )}

        {loading ? (
          <View style={styles.centerBox}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.errBox}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
            <Text style={styles.errTxt}>{error}</Text>
          </View>
        ) : !pid ? (
          <View style={styles.emptyCard}>
            <Ionicons name="folder-open-outline" size={36} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Sin proyectos asignados</Text>
            <Text style={styles.emptyMsg}>
              Pídele a tu Coordinador General que te asigne a un proyecto para ver el panel.
            </Text>
          </View>
        ) : (
          <>
            {/* Resumen Ejecutivo */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={[styles.cardIcon, { backgroundColor: colors.primary }]}>
                  <Ionicons name="speedometer" size={16} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Resumen Ejecutivo</Text>
                  <Text style={styles.cardSubtitle}>
                    Promedio de avance sobre nodos con meta definida
                  </Text>
                </View>
              </View>

              <View style={styles.summaryBody}>
                <View style={styles.bigPctBox}>
                  <Text style={[styles.bigPctValue, { color: progressTint(globalPct) }]}>
                    {globalPct}%
                  </Text>
                  <Text style={styles.bigPctLabel}>Avance global</Text>
                </View>

                <View style={styles.summaryStats}>
                  <View style={styles.statRow}>
                    <Ionicons name="git-network-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.statTxt}>
                      {progressRows.length} nodos con meta
                    </Text>
                  </View>
                  <View style={styles.statRow}>
                    <Ionicons name="document-text-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.statTxt}>
                      {reports.length} reportes hoy
                    </Text>
                  </View>
                  <View style={styles.statRow}>
                    <Ionicons name="alert-circle-outline" size={14} color={colors.error} />
                    <Text style={styles.statTxt}>
                      {alerts.length} en alerta
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    { width: `${globalPct}%`, backgroundColor: progressTint(globalPct) },
                  ]}
                />
              </View>

              <Pressable
                onPress={onExport}
                disabled={exporting}
                style={({ pressed }) => [
                  styles.exportBtn,
                  pressed && { opacity: 0.85 },
                  exporting && { opacity: 0.65 },
                ]}
              >
                {exporting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Ionicons name="download-outline" size={16} color="#fff" />
                )}
                <Text style={styles.exportBtnTxt}>
                  {exporting ? 'Exportando…' : 'Exportar Reportes (Excel)'}
                </Text>
              </Pressable>
            </View>

            {/* Alertas Semáforo */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={[styles.cardIcon, { backgroundColor: colors.error }]}>
                  <Ionicons name="warning" size={16} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Alertas Semáforo</Text>
                  <Text style={styles.cardSubtitle}>
                    Nodos con avance menor al 50% de su meta
                  </Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeTxt}>{alerts.length}</Text>
                </View>
              </View>

              {alerts.length === 0 ? (
                <View style={styles.emptyInline}>
                  <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                  <Text style={styles.emptyInlineTxt}>
                    Sin alertas activas. Todos los nodos con meta van bien.
                  </Text>
                </View>
              ) : (
                <View style={{ gap: spacing.sm }}>
                  {alerts.slice(0, 10).map((r) => (
                    <View key={r.node.id} style={styles.alertRow}>
                      <View style={[styles.dot, { backgroundColor: progressTint(r.pct) }]} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.alertName} numberOfLines={1}>
                          {r.node.name}
                        </Text>
                        <View style={styles.alertMiniBar}>
                          <View
                            style={[
                              styles.alertMiniFill,
                              {
                                width: `${Math.max(4, r.pct)}%`,
                                backgroundColor: progressTint(r.pct),
                              },
                            ]}
                          />
                        </View>
                        <Text style={styles.alertMeta}>
                          {r.count} / {r.node.meta} reportes
                        </Text>
                      </View>
                      <Text style={[styles.alertPct, { color: progressTint(r.pct) }]}>
                        {r.pct}%
                      </Text>
                    </View>
                  ))}
                  {alerts.length > 10 && (
                    <Text style={styles.alertMore}>+{alerts.length - 10} más…</Text>
                  )}
                </View>
              )}
            </View>

            {/* Feed de Reportes Recientes */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={[styles.cardIcon, { backgroundColor: colors.success }]}>
                  <Ionicons name="albums" size={16} color="#fff" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardTitle}>Reportes Recientes</Text>
                  <Text style={styles.cardSubtitle}>Capturas del día de hoy</Text>
                </View>
              </View>

              {todayReports.length === 0 ? (
                <View style={styles.emptyInline}>
                  <Ionicons name="time-outline" size={18} color={colors.textMuted} />
                  <Text style={styles.emptyInlineTxt}>
                    Aún no hay reportes capturados hoy.
                  </Text>
                </View>
              ) : (
                <View style={{ gap: spacing.sm }}>
                  {todayReports.map((r) => (
                    <View key={r.id} style={styles.feedRow}>
                      <View
                        style={[
                          styles.feedAvatar,
                          { backgroundColor: r.area_color || colors.primary },
                        ]}
                      >
                        <Text style={styles.feedAvatarTxt}>
                          {(r.captured_by_name || '?').slice(0, 1).toUpperCase()}
                        </Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.feedName} numberOfLines={1}>
                          {r.captured_by_name}
                        </Text>
                        <Text style={styles.feedPath} numberOfLines={1}>
                          {(r.node_path_names || []).join(' › ') || '—'}
                        </Text>
                        {!!r.avance && (
                          <Text style={styles.feedAvance} numberOfLines={2}>
                            {r.avance}
                          </Text>
                        )}
                      </View>
                      <Text style={styles.feedTime}>{formatTime(r.created_at)}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  brand: { fontSize: 18, fontWeight: '900', color: colors.primary, letterSpacing: -0.4 },
  role: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginTop: 2 },
  logoutBtn: { padding: 6, borderRadius: radius.full },

  scroll: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
    paddingTop: spacing.sm,
  },
  greeting: { fontSize: 22, fontWeight: '900', color: colors.text },
  projRow: { gap: spacing.sm, paddingVertical: 4 },
  projChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    maxWidth: 220,
  },
  projChipSel: { backgroundColor: colors.primary, borderColor: colors.primary },
  projChipTxt: { fontSize: 12, fontWeight: '800', color: colors.textBody },
  projChipTxtSel: { color: '#fff' },
  projTitle: { fontSize: 14, fontWeight: '800', color: colors.textBody },

  centerBox: { padding: spacing.xl, alignItems: 'center' },
  errBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: spacing.md,
    backgroundColor: colors.errorBg,
    borderRadius: radius.md,
  },
  errTxt: { color: colors.error, fontSize: 13, flex: 1, fontWeight: '700' },

  emptyCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  emptyMsg: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadow.card,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  cardSubtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontWeight: '600' },

  badge: {
    minWidth: 26,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.errorBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTxt: { fontSize: 12, fontWeight: '900', color: colors.error },

  summaryBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  bigPctBox: {
    width: 110,
    height: 110,
    borderRadius: 55,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    borderWidth: 4,
    borderColor: colors.border,
  },
  bigPctValue: { fontSize: 26, fontWeight: '900' },
  bigPctLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, marginTop: 2 },
  summaryStats: { flex: 1, gap: 8 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statTxt: { fontSize: 13, color: colors.textBody, fontWeight: '700' },

  barTrack: {
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: radius.full },

  exportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: radius.md,
    marginTop: 4,
    minHeight: 44,
  },
  exportBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },

  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  alertName: { fontSize: 13, fontWeight: '800', color: colors.text },
  alertMiniBar: {
    height: 5,
    borderRadius: radius.full,
    backgroundColor: colors.border,
    overflow: 'hidden',
    marginTop: 4,
  },
  alertMiniFill: { height: '100%', borderRadius: radius.full },
  alertMeta: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginTop: 2 },
  alertPct: { fontSize: 14, fontWeight: '900', minWidth: 44, textAlign: 'right' },
  alertMore: {
    fontSize: 11,
    color: colors.textMuted,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 4,
  },

  feedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
  },
  feedAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedAvatarTxt: { color: '#fff', fontWeight: '900', fontSize: 14 },
  feedName: { fontSize: 13, fontWeight: '800', color: colors.text },
  feedPath: { fontSize: 11, color: colors.textMuted, fontWeight: '600', marginTop: 1 },
  feedAvance: { fontSize: 12, color: colors.textBody, marginTop: 3 },
  feedTime: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },

  emptyInline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  emptyInlineTxt: { fontSize: 13, color: colors.textMuted, flex: 1, fontWeight: '600' },
});
