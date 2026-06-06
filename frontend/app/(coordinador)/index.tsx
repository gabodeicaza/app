import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  Pressable,
  ActivityIndicator,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { AreaChip } from '@/src/components/AreaChip';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { fmtFullDate, fmtTime } from '@/src/utils/format';

interface Report {
  id: string;
  title: string;
  comments: string;
  area: string;
  areaName: string;
  images: string[];
  location?: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

interface StatItem { name: string; color: string; count: number }

export default function CoordHome() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState<Record<string, StatItem>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.reportsToday();
      setReports(data.reports || []);
      setStats(data.stats || {});
    } catch (e) {
      // keep stale data
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const total = reports.length;
  const statList = useMemo(() => Object.entries(stats).map(([id, s]) => ({ id, ...s })), [stats]);

  return (
    <View style={styles.flex}>
      <AppHeader
        title={`Hola, ${user?.name?.split(' ')[0] || 'Coordinador'}`}
        subtitle={fmtFullDate(new Date().toISOString())}
      />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        <View style={styles.heroCard}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroLabel}>REPORTES HOY</Text>
            <Text style={styles.heroValue}>{total}</Text>
            <Text style={styles.heroSub}>Resumen ejecutivo disponible con IA</Text>
          </View>
          <Pressable
            onPress={() => router.push('/(coordinador)/summary')}
            style={styles.heroBtn}
          >
            <Ionicons name="sparkles" color="#fff" size={16} />
            <Text style={styles.heroBtnText}>Generar resumen</Text>
          </Pressable>
        </View>

        <Text style={styles.section}>Por área</Text>
        {statList.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="grid-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyText}>Aún no hay áreas configuradas.</Text>
          </View>
        ) : (
          <View style={styles.statsGrid}>
            {statList.map((s) => (
              <View key={s.id} style={[styles.statCard, { borderLeftColor: s.color }]}>
                <Text style={styles.statName} numberOfLines={1}>{s.name}</Text>
                <Text style={[styles.statCount, { color: s.color }]}>{s.count}</Text>
                <Text style={styles.statSub}>reporte{s.count === 1 ? '' : 's'}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.sectionRow}>
          <Text style={styles.section}>Reportes del día</Text>
          <Text style={styles.sectionMuted}>{total}</Text>
        </View>

        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : reports.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="document-text-outline" size={32} color={colors.textMuted} />
            <Text style={styles.emptyText}>Aún no hay reportes enviados hoy.</Text>
          </View>
        ) : (
          reports.map((r) => (
            <Pressable
              key={r.id}
              onPress={() => router.push({ pathname: '/(coordinador)/report/[id]', params: { id: r.id } })}
              style={styles.reportCard}
            >
              <View style={styles.reportTop}>
                <AreaChip name={r.areaName} color={stats[r.area]?.color} />
                <Text style={styles.reportTime}>{fmtTime(r.createdAt)}</Text>
              </View>
              <Text numberOfLines={1} style={styles.reportTitle}>{r.title}</Text>
              {r.comments ? <Text numberOfLines={2} style={styles.reportComment}>{r.comments}</Text> : null}
              <View style={styles.reportFooter}>
                <View style={styles.reportFooterItem}>
                  <Ionicons name="person-outline" size={13} color={colors.textMuted} />
                  <Text style={styles.reportFooterText}>{r.createdByName}</Text>
                </View>
                {r.images?.length ? (
                  <View style={styles.reportFooterItem}>
                    <Ionicons name="images-outline" size={13} color={colors.textMuted} />
                    <Text style={styles.reportFooterText}>{r.images.length}</Text>
                  </View>
                ) : null}
              </View>
              {r.images?.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 10 }}>
                  {r.images.slice(0, 6).map((img, i) => (
                    <Image key={i} source={{ uri: img }} style={styles.thumb} />
                  ))}
                </ScrollView>
              ) : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.sm },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
    ...shadow.card,
  },
  heroLabel: { color: '#DBEAFE', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  heroValue: { color: '#fff', fontSize: 38, fontWeight: '900', marginTop: 2, lineHeight: 42 },
  heroSub: { color: '#DBEAFE', fontSize: 12, marginTop: 4, maxWidth: 200 },
  heroBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#1E3A8A',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  heroBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  section: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.md },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.md },
  sectionMuted: { fontSize: 13, color: colors.textMuted, fontWeight: '700' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 6 },
  statCard: {
    width: '48%',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    padding: spacing.md,
  },
  statName: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  statCount: { fontSize: 26, fontWeight: '900', marginTop: 4 },
  statSub: { fontSize: 11, color: colors.textMuted },
  reportCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  reportTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reportTime: { fontSize: 12, color: colors.textMuted, fontWeight: '700' },
  reportTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 8 },
  reportComment: { fontSize: 13, color: colors.textBody, marginTop: 4, lineHeight: 18 },
  reportFooter: { flexDirection: 'row', gap: 14, marginTop: 8 },
  reportFooterItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  reportFooterText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  thumb: { width: 72, height: 72, borderRadius: 8, marginRight: 8, backgroundColor: colors.border },
  empty: { alignItems: 'center', padding: spacing.lg, gap: 6 },
  emptyText: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  loading: { padding: spacing.lg, alignItems: 'center' },
});
