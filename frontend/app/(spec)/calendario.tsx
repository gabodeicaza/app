// SynCo v2.0 — Tab "Calendario" — vista de lectura agrupada por sección temporal.
// Sin librería externa: lista limpia con secciones Hoy / Mañana / Esta semana / Más adelante.
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator, Pressable, RefreshControl, ScrollView, StatusBar,
  StyleSheet, Text, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/src/auth-context';
import { api, ProjectEvent } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { groupEvents, formatEventTime, formatEventDate } from '@/src/utils/events';

type RangeKey = 'upcoming' | 'past';
const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'upcoming', label: 'Próximos' },
  { key: 'past', label: 'Pasados' },
];

export default function CalendarioScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const projectId = (user?.project_ids || [])[0] || '';

  const [items, setItems] = useState<ProjectEvent[]>([]);
  const [range, setRange] = useState<RangeKey>('upcoming');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextRange: RangeKey = range, silent = false) => {
    if (!projectId) { setLoading(false); setError('Sin proyecto asignado'); return; }
    try {
      if (!silent) setLoading(true);
      setError(null);
      const data = await api.listEvents(projectId, nextRange, 500);
      setItems(data);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar los eventos');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, range]);

  useFocusEffect(useCallback(() => { load(range, false); }, [load, range]));

  const sections = useMemo(() => groupEvents(items, range), [items, range]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.blueTop, { height: 200 + insets.top }]} />

      <View style={[styles.header, { paddingTop: insets.top + spacing.xs }]}>
        <View style={styles.headerIcon}>
          <Ionicons name="calendar" size={18} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Calendario</Text>
          <Text style={styles.headerSubtitle}>Eventos del proyecto</Text>
        </View>
        <Pressable onPress={() => load(range, false)} hitSlop={10} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={18} color="#fff" />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: spacing.xl, paddingHorizontal: spacing.md, gap: spacing.sm }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(range, true); }}
            tintColor="#fff"
            colors={[colors.primary]}
          />
        }
      >
        {/* Resumen + chips */}
        <View style={styles.summaryCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.summaryLabel}>EVENTOS · PROYECTO</Text>
            <Text style={styles.summaryValue}>{items.length}</Text>
          </View>
          <View style={styles.chipsRow}>
            {RANGE_OPTIONS.map((opt) => {
              const active = range === opt.key;
              return (
                <Pressable
                  key={opt.key}
                  onPress={() => { setRange(opt.key); load(opt.key, true); }}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <Text style={[styles.chipTxt, active && styles.chipTxtActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={22} color={colors.error} />
            <Text style={styles.errorTxt}>{error}</Text>
            <Pressable onPress={() => load(range, false)} style={styles.retryBtn}>
              <Text style={styles.retryTxt}>Reintentar</Text>
            </Pressable>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="calendar-outline" size={28} color={colors.primary} />
            </View>
            <Text style={styles.emptyTitle}>
              {range === 'upcoming' ? 'Sin eventos próximos' : 'Sin eventos pasados'}
            </Text>
            <Text style={styles.emptyMsg}>
              Cuando el Coordinador programe actividades, aparecerán aquí.
            </Text>
          </View>
        ) : (
          sections.map((section) => (
            <View key={section.key} style={{ gap: 6, marginTop: 4 }}>
              <Text style={styles.sectionTitle}>{section.title}</Text>
              {section.items.map((e) => <EventCard key={e.id} item={e} />)}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function EventCard({ item }: { item: ProjectEvent }) {
  return (
    <View style={styles.card}>
      <View style={styles.dateBlock}>
        <Text style={styles.dateDay}>{new Date(item.start_at).getDate()}</Text>
        <Text style={styles.dateMonth}>
          {new Date(item.start_at).toLocaleDateString('es-MX', { month: 'short' }).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
        <View style={styles.metaRow}>
          <Ionicons name="time-outline" size={12} color={colors.primary} />
          <Text style={styles.metaTxtPrimary}>{formatEventTime(item)}</Text>
        </View>
        {item.location ? (
          <View style={styles.metaRow}>
            <Ionicons name="location-outline" size={12} color={colors.textMuted} />
            <Text style={styles.metaTxt} numberOfLines={1}>{item.location}</Text>
          </View>
        ) : null}
        {item.description ? (
          <Text style={styles.descTxt} numberOfLines={3}>{item.description}</Text>
        ) : null}
        <View style={styles.authorRow}>
          <Ionicons name="person-circle-outline" size={11} color={colors.textMuted} />
          <Text style={styles.authorTxt}>{item.author_name}</Text>
          <Text style={styles.metaDot}>·</Text>
          <Text style={styles.authorTxt}>{formatEventDate(item.start_at)}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  blueTop: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: colors.primary },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm,
  },
  headerIcon: {
    width: 36, height: 36, borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  headerSubtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 1 },
  refreshBtn: {
    width: 36, height: 36, borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },

  summaryCard: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, ...shadow.card,
  },
  summaryLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 1 },
  summaryValue: { fontSize: 28, fontWeight: '800', color: colors.text, marginTop: 2 },
  chipsRow: { flexDirection: 'row', gap: 6 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipTxt: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  chipTxtActive: { color: '#fff' },

  sectionTitle: {
    fontSize: 11, fontWeight: '800', color: '#fff',
    textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.sm,
    paddingHorizontal: 4,
  },

  card: {
    flexDirection: 'row', gap: spacing.sm,
    backgroundColor: colors.surface, borderRadius: radius.md,
    padding: spacing.sm + 2, alignItems: 'flex-start',
    borderWidth: 1, borderColor: colors.border, ...shadow.card,
  },
  dateBlock: {
    width: 56, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primaryLight, borderRadius: radius.md,
    paddingVertical: 8,
  },
  dateDay: { fontSize: 22, fontWeight: '800', color: colors.primary, lineHeight: 24 },
  dateMonth: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.6 },

  cardTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 4 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  metaTxt: { fontSize: 12, color: colors.textBody, flex: 1 },
  metaTxtPrimary: { fontSize: 12, color: colors.primary, fontWeight: '700' },
  metaDot: { fontSize: 11, color: colors.textMuted, marginHorizontal: 2 },
  descTxt: { fontSize: 12, color: colors.textBody, marginTop: 6, lineHeight: 17 },
  authorRow: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 8, paddingTop: 6,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  authorTxt: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },

  center: { padding: spacing.xl, alignItems: 'center' },
  errorBox: {
    padding: spacing.lg, alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
  },
  errorTxt: { textAlign: 'center', color: colors.textBody, fontSize: 13 },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.md },
  retryTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  empty: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg,
    alignItems: 'center', gap: 6, ...shadow.card,
  },
  emptyIcon: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  emptyMsg: { fontSize: 12, color: colors.textBody, textAlign: 'center', lineHeight: 18 },
});
