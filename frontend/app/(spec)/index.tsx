// SynCo v2.0 — Tab "Inicio" / Feed del Especialista.
// Cumple con la descripción exacta solicitada por el usuario:
//   • Fondo azul corporativo en la mitad superior.
//   • Hero Card "MI ÁREA ASIGNADA" en blanco con datos del especialista.
//   • Tres Stat Cards blancas (Total · Míos · De compañeros).
//   • Chips horizontales de filtro temporal (Hoy / Semana / Mes / Todo).
//   • Lista vertical de actividad con thumbnail a la izquierda, badge de
//     área coloreado, título en negritas y meta debajo.
//   • Pull-to-refresh y estados vacíos amigables.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Platform, Pressable, RefreshControl,
  ScrollView, StatusBar, StyleSheet, Text, View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/src/auth-context';
import { colors, radius, shadow, spacing, areaTone } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';
import { api, FeedItem, FeedResponse, Project } from '@/src/api';

type RangeKey = 'today' | 'week' | 'month' | 'all';

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'today', label: 'Hoy' },
  { key: 'week', label: 'Esta semana' },
  { key: 'month', label: 'Este mes' },
  { key: 'all', label: 'Todos' },
];

export default function SpecFeedScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const projectId = (user?.project_ids || [])[0] || '';

  const [project, setProject] = useState<Project | null>(null);
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [range, setRange] = useState<RangeKey>('today');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextRange: RangeKey = range, silent = false) => {
    if (!projectId) {
      setLoading(false);
      setError('Tu cuenta no está asociada a ningún proyecto. Pide a tu Coordinador General una invitación.');
      return;
    }
    try {
      setError(null);
      if (!silent) setLoading(true);
      const [proj, f] = await Promise.all([
        project ? Promise.resolve(project) : api.getProject(projectId),
        api.feed(projectId, nextRange, 100),
      ]);
      setProject(proj);
      setFeed(f);
    } catch (e: any) {
      setError(e?.message || 'No se pudo cargar el feed');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, range]);

  useEffect(() => { load(range, false); /* initial */ }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  function onPickRange(r: RangeKey) {
    setRange(r);
    load(r, true);
  }

  async function onLogout() {
    const ok = await confirm('Cerrar sesión', '¿Seguro que quieres salir?', { confirmText: 'Salir', destructive: true });
    if (!ok) return;
    await logout();
    router.replace('/(auth)/login');
  }

  const stats = feed?.stats || { total: 0, mine: 0, others: 0 };
  const reports = feed?.reports || [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />
      {/* Fondo azul que cubre la zona superior */}
      <View style={[styles.blueTop, { height: 240 + insets.top }]} />

      {/* Header transparente sobre el azul */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.xs }]}>
        <Pressable hitSlop={10} style={styles.headerBtn} onPress={onLogout}>
          <Ionicons name="menu" size={22} color="#fff" />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.headerTitle}>SynCo</Text>
          <Text style={styles.headerSubtitle} numberOfLines={1}>
            {project?.name || 'Cargando proyecto…'}
          </Text>
        </View>
        <Pressable hitSlop={10} style={styles.headerBtn}>
          <Ionicons name="notifications-outline" size={22} color="#fff" />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: spacing.xl }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(range, true); }}
            tintColor="#fff"
            colors={[colors.primary]}
          />
        }
      >
        {/* Hero Card: MI ÁREA ASIGNADA */}
        <View style={[styles.heroWrap, { marginTop: spacing.sm }]}>
          <View style={styles.heroCard}>
            <View style={styles.heroHeaderRow}>
              <View style={styles.heroIcon}>
                <Ionicons name="location" size={18} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.heroLabel}>MI ÁREA ASIGNADA</Text>
                <Text style={styles.heroTitle} numberOfLines={1}>
                  {user?.area || 'Sin área asignada'}
                </Text>
              </View>
              <View style={styles.heroLeavesPill}>
                <Ionicons name="flag" size={11} color={colors.primary} />
                <Text style={styles.heroLeavesTxt}>
                  {(user?.scope_node_ids || []).length} hojas
                </Text>
              </View>
            </View>
            {user?.puesto ? (
              <Text style={styles.heroPuesto}>{user.puesto}</Text>
            ) : null}
            {project?.contract_number ? (
              <Text style={styles.heroMeta}>
                Contrato {project.contract_number}
                {project.constructora ? `  ·  ${project.constructora}` : ''}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Stat Cards */}
        <View style={styles.statsRow}>
          <StatCard
            label="Total"
            value={stats.total}
            icon="albums-outline"
            tint={colors.primary}
          />
          <StatCard
            label="Míos"
            value={stats.mine}
            icon="person"
            tint="#0EA5E9"
          />
          <StatCard
            label="Compañeros"
            value={stats.others}
            icon="people-outline"
            tint="#10B981"
          />
        </View>

        {/* Filtros temporales */}
        <View style={styles.timeFiltersWrap}>
          <Text style={styles.sectionLabel}>Filtrar actividad</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}
          >
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.key;
              return (
                <Pressable
                  key={opt.key}
                  onPress={() => onPickRange(opt.key)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Lista de actividad */}
        <View style={styles.feedHeaderRow}>
          <Text style={styles.feedTitle}>Actividad reciente</Text>
          {feed && reports.length > 0 ? (
            <Text style={styles.feedCount}>{reports.length}</Text>
          ) : null}
        </View>

        {loading ? (
          <View style={styles.centerPad}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={24} color={colors.error} />
            <Text style={styles.errorTxt}>{error}</Text>
            <Pressable onPress={() => load(range, false)} style={styles.retryBtn}>
              <Text style={styles.retryTxt}>Reintentar</Text>
            </Pressable>
          </View>
        ) : reports.length === 0 ? (
          <EmptyFeed range={range} onNew={() => router.push('/(spec)/nuevo' as any)} />
        ) : (
          <FlatList
            data={reports}
            keyExtractor={(it) => it.id}
            scrollEnabled={false}
            contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm, paddingBottom: spacing.md }}
            renderItem={({ item }) => <FeedCard item={item} />}
          />
        )}
      </ScrollView>
    </View>
  );
}

// ============================================================================
// Componentes auxiliares
// ============================================================================
function StatCard({ label, value, icon, tint }: {
  label: string; value: number; icon: keyof typeof Ionicons.glyphMap; tint: string;
}) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statIcon, { backgroundColor: tint + '1A' }]}>
        <Ionicons name={icon} size={16} color={tint} />
      </View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function FeedCard({ item }: { item: FeedItem }) {
  const tone = areaTone(item.area_color || undefined);
  const path = item.node_path_names || [];
  const leafName = path[path.length - 1] || 'Sin ubicación';
  const parentName = path.length >= 2 ? path[path.length - 2] : '';
  const subtitle = parentName ? `${parentName} · ${leafName}` : leafName;
  const ago = timeAgo(item.created_at);
  const measure = formatMeasurement(item.measurement_type, item.measurement_value);

  return (
    <Pressable
      style={({ pressed }) => [styles.feedCard, pressed && { opacity: 0.85 }]}
      onPress={() => { /* preview no implementado todavía */ }}
    >
      {/* Thumbnail */}
      <View style={styles.thumbWrap}>
        {item.thumbnail_base64 ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${item.thumbnail_base64}` }}
            style={styles.thumb}
          />
        ) : (
          <View style={[styles.thumb, styles.thumbPlaceholder]}>
            <Ionicons name="image-outline" size={26} color={colors.textMuted} />
          </View>
        )}
        {item.images_count > 1 ? (
          <View style={styles.thumbBadge}>
            <Ionicons name="copy" size={9} color="#fff" />
            <Text style={styles.thumbBadgeTxt}>{item.images_count}</Text>
          </View>
        ) : null}
      </View>

      {/* Contenido */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.feedTopRow}>
          {item.area_name ? (
            <View style={[styles.areaBadge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
              <View style={[styles.areaDot, { backgroundColor: tone.text }]} />
              <Text style={[styles.areaBadgeTxt, { color: tone.text }]} numberOfLines={1}>
                {item.area_name}
              </Text>
            </View>
          ) : (
            <View style={[styles.areaBadge, styles.areaBadgeNeutral]}>
              <Text style={styles.areaBadgeTxtNeutral}>Sin área</Text>
            </View>
          )}
          {item.is_mine ? (
            <View style={styles.minePill}>
              <Text style={styles.minePillTxt}>Mío</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.feedCardTitle} numberOfLines={1}>{leafName}</Text>
        <Text style={styles.feedCardSub} numberOfLines={1}>{subtitle}</Text>
        <View style={styles.feedMetaRow}>
          <Ionicons name="time-outline" size={12} color={colors.textMuted} />
          <Text style={styles.feedMeta} numberOfLines={1}>{ago}</Text>
          <Text style={styles.feedMetaDot}>·</Text>
          <Ionicons name="person-outline" size={12} color={colors.textMuted} />
          <Text style={styles.feedMeta} numberOfLines={1}>
            {item.captured_by_name || '—'}
          </Text>
        </View>
        {measure ? (
          <View style={styles.measureRow}>
            <Ionicons name="speedometer-outline" size={12} color={colors.primary} />
            <Text style={styles.measureTxt} numberOfLines={1}>{measure}</Text>
          </View>
        ) : null}
        {item.avance ? (
          <Text style={styles.avanceTxt} numberOfLines={2}>{item.avance}</Text>
        ) : null}
      </View>

      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

function EmptyFeed({ range, onNew }: { range: RangeKey; onNew: () => void }) {
  const lbl = RANGE_OPTIONS.find((r) => r.key === range)?.label.toLowerCase() || '';
  return (
    <View style={styles.emptyBox}>
      <View style={styles.emptyIcon}>
        <Ionicons name="reader-outline" size={28} color={colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>Sin reportes en {lbl}</Text>
      <Text style={styles.emptyMsg}>
        Cuando tú o tus compañeros capturen actividad, aparecerá aquí.
      </Text>
      <Pressable style={styles.emptyBtn} onPress={onNew}>
        <Ionicons name="add" size={18} color="#fff" />
        <Text style={styles.emptyBtnTxt}>Crear nuevo reporte</Text>
      </Pressable>
    </View>
  );
}

// ============================================================================
// Helpers
// ============================================================================
function timeAgo(iso?: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, Date.now() - t);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Hace instantes';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `Hace ${d} d`;
  const date = new Date(iso);
  return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

function formatMeasurement(type?: string | null, v?: Record<string, any> | null): string {
  if (!type || !v) return '';
  if (type === 'coord_latlon') {
    if (typeof v.lat === 'number' && typeof v.lon === 'number') {
      return `${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}`;
    }
  }
  if (type === 'cadenamiento' && v.cadenamiento) return `Cad. ${v.cadenamiento}`;
  if (type === 'eje' && v.eje) return `Eje ${v.eje}`;
  if (type === 'nivel' && typeof v.nivel === 'number') return `Nivel ${v.nivel} m`;
  return '';
}

// ============================================================================
// Styles
// ============================================================================
const styles = StyleSheet.create({
  blueTop: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    backgroundColor: colors.primary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  headerBtn: {
    width: 36, height: 36, borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#fff', fontSize: 16, fontWeight: '800', letterSpacing: 0.4 },
  headerSubtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 1, maxWidth: '80%' },

  // Hero
  heroWrap: { paddingHorizontal: spacing.md },
  heroCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: 4,
    ...shadow.card,
  },
  heroHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  heroIcon: {
    width: 36, height: 36, borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  heroLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 1.2 },
  heroTitle: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: 1 },
  heroPuesto: { fontSize: 13, color: colors.textBody, marginTop: 4, marginLeft: 36 + spacing.sm },
  heroMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2, marginLeft: 36 + spacing.sm },
  heroLeavesPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.full,
  },
  heroLeavesTxt: { color: colors.primary, fontSize: 10, fontWeight: '800' },

  // Stat row
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.sm + 2,
    alignItems: 'flex-start',
    gap: 4,
    ...shadow.card,
  },
  statIcon: {
    width: 28, height: 28, borderRadius: radius.full,
    alignItems: 'center', justifyContent: 'center',
  },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },

  // Time filters
  timeFiltersWrap: { marginTop: spacing.md },
  sectionLabel: {
    fontSize: 11, fontWeight: '800', color: colors.textMuted,
    letterSpacing: 1, textTransform: 'uppercase',
    paddingHorizontal: spacing.md, marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipTxt: { fontSize: 13, fontWeight: '700', color: colors.textBody },
  chipTxtActive: { color: '#fff' },

  // Feed header
  feedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  feedTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  feedCount: {
    fontSize: 11, fontWeight: '800', color: colors.primary,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full,
  },

  // Feed card
  feedCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.sm + 2,
    gap: spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  thumbWrap: {
    width: 72, height: 72, borderRadius: radius.md, overflow: 'hidden',
    backgroundColor: colors.bg,
  },
  thumb: { width: '100%', height: '100%' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primaryLight },
  thumbBadge: {
    position: 'absolute', bottom: 4, right: 4,
    flexDirection: 'row', alignItems: 'center', gap: 2,
    backgroundColor: 'rgba(15,23,42,0.7)',
    paddingHorizontal: 5, paddingVertical: 2,
    borderRadius: radius.full,
  },
  thumbBadgeTxt: { color: '#fff', fontSize: 9, fontWeight: '800' },

  feedTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  areaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: radius.full,
    borderWidth: 1,
    maxWidth: 160,
  },
  areaBadgeNeutral: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
  },
  areaDot: { width: 6, height: 6, borderRadius: 3 },
  areaBadgeTxt: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  areaBadgeTxtNeutral: { fontSize: 10, fontWeight: '800', color: colors.textMuted },
  minePill: {
    backgroundColor: colors.success + '22',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full,
  },
  minePillTxt: { color: colors.success, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 },

  feedCardTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
  feedCardSub: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  feedMetaRow: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 4,
  },
  feedMeta: { fontSize: 11, color: colors.textMuted },
  feedMetaDot: { color: colors.textMuted, fontSize: 11, marginHorizontal: 2 },
  measureRow: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4,
  },
  measureTxt: { fontSize: 11, fontWeight: '700', color: colors.primary },
  avanceTxt: { fontSize: 11, color: colors.textBody, marginTop: 4, fontStyle: 'italic' },

  // States
  centerPad: { padding: spacing.xl, alignItems: 'center' },
  errorBox: { padding: spacing.lg, alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.md, marginTop: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  errorTxt: { textAlign: 'center', color: colors.textBody, fontSize: 13 },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.md },
  retryTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },

  emptyBox: {
    marginHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.lg,
    alignItems: 'center',
    gap: 6,
    ...shadow.card,
  },
  emptyIcon: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  emptyMsg: { fontSize: 12, color: colors.textBody, textAlign: 'center', lineHeight: 18 },
  emptyBtn: {
    marginTop: spacing.sm,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: radius.md,
  },
  emptyBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
});

// Suprime ESLint warning para web platform-specific styles si los hubiese.
void Platform;
