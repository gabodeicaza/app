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
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import DateTimePicker from '@react-native-community/datetimepicker';
import { AppHeader } from '@/src/components/AppHeader';
import { AreaChip } from '@/src/components/AreaChip';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { useSync } from '@/src/sync-context';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { fmtFullDate, fmtTime } from '@/src/utils/format';
import { exportSupervisorReport } from '@/src/utils/pdf-export';

type TimeFilter = 'today' | 'yesterday' | 'week' | 'custom' | 'all';
type OwnerTab = 'mine' | 'team';

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

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function endOfDay(d: Date) { const x = new Date(d); x.setHours(23,59,59,999); return x; }

export default function EspHome() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { queue, pendingCount, syncNow, syncing, online } = useSync();
  const [reports, setReports] = useState<Report[]>([]);
  const [areaName, setAreaName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filtros temporales
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('today');
  const [customDate, setCustomDate] = useState<Date | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listReports();
      setReports(data || []);
      if (data?.[0]?.areaName) setAreaName(data[0].areaName);
      else if (user?.area) {
        try {
          const areas = await api.listAreas();
          const a = areas.find((x: any) => x.id === user.area);
          if (a) setAreaName(a.name);
        } catch {}
      }
    } catch {
      // keep stale
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user?.area]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  // Aplicar filtro temporal
  const filteredReports = useMemo(() => {
    if (timeFilter === 'all') return reports;
    const now = new Date();
    let from: Date, to: Date;
    if (timeFilter === 'today') {
      from = startOfDay(now); to = endOfDay(now);
    } else if (timeFilter === 'yesterday') {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      from = startOfDay(y); to = endOfDay(y);
    } else if (timeFilter === 'week') {
      const w = new Date(now); w.setDate(w.getDate() - 6);
      from = startOfDay(w); to = endOfDay(now);
    } else { // custom
      if (!customDate) return reports;
      from = startOfDay(customDate); to = endOfDay(customDate);
    }
    return reports.filter((r) => {
      const t = new Date(r.createdAt).getTime();
      return t >= from.getTime() && t <= to.getTime();
    });
  }, [reports, timeFilter, customDate]);

  const myReports = filteredReports.filter((r) => r.createdBy === user?.id);
  const teamReports = filteredReports.filter((r) => r.createdBy !== user?.id);

  const filterLabel = useMemo(() => {
    if (timeFilter === 'today') return 'Hoy';
    if (timeFilter === 'yesterday') return 'Ayer';
    if (timeFilter === 'week') return 'Esta semana';
    if (timeFilter === 'all') return 'Todos';
    if (timeFilter === 'custom' && customDate) {
      return customDate.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
    }
    return 'Fecha';
  }, [timeFilter, customDate]);

  const onPickDate = (event: any, date?: Date) => {
    // Android: el picker se cierra automáticamente al seleccionar
    if (Platform.OS !== 'ios') setShowPicker(false);
    if (event?.type === 'dismissed') return;
    if (date) {
      setCustomDate(date);
      setTimeFilter('custom');
    }
  };

  return (
    <View style={styles.flex}>
      <AppHeader
        title={`Hola, ${user?.name?.split(' ')[0] || ''}`}
        subtitle={fmtFullDate(new Date().toISOString())}
      />

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* Area banner */}
        <View style={[styles.banner, shadow.card]}>
          <View style={styles.bannerRow}>
            <View style={styles.bannerIcon}>
              <Ionicons name="hammer" size={20} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerLabel}>Mi área asignada</Text>
              <Text style={styles.bannerArea}>{areaName || 'Sin área asignada'}</Text>
            </View>
            <Pressable style={styles.bannerCta} onPress={() => router.push('/(especialista)/new')}>
              <Ionicons name="add" size={18} color="#fff" />
              <Text style={styles.bannerCtaText}>Nuevo</Text>
            </Pressable>
          </View>
        </View>

        {/* Pending queue card */}
        {pendingCount > 0 ? (
          <View style={styles.queueCard}>
            <Ionicons name="cloud-upload-outline" size={20} color={colors.syncing} />
            <View style={{ flex: 1 }}>
              <Text style={styles.queueTitle}>
                {pendingCount} reporte{pendingCount === 1 ? '' : 's'} pendiente{pendingCount === 1 ? '' : 's'}
              </Text>
              <Text style={styles.queueSub}>
                {online ? 'Sincronizando…' : 'Se enviarán cuando recuperes la conexión.'}
              </Text>
            </View>
            {online ? (
              <Pressable onPress={syncNow} disabled={syncing} style={styles.queueBtn}>
                {syncing ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name="refresh" size={18} color={colors.primary} />
                )}
              </Pressable>
            ) : null}
          </View>
        ) : null}


        {/* Stats */}
        <View style={styles.stats}>
          <Stat icon="document-text" label={`Reportes ${filterLabel.toLowerCase()}`} value={filteredReports.length} />
          <Stat icon="person" label="Míos" value={myReports.length} />
          <Stat icon="people" label="De compañeros" value={teamReports.length} />
        </View>

        {/* Time filter pills */}
        <View style={styles.pillsRow}>
          <Pill label="Hoy" active={timeFilter === 'today'} onPress={() => { setTimeFilter('today'); setCustomDate(null); }} />
          <Pill label="Ayer" active={timeFilter === 'yesterday'} onPress={() => { setTimeFilter('yesterday'); setCustomDate(null); }} />
          <Pill label="Esta semana" active={timeFilter === 'week'} onPress={() => { setTimeFilter('week'); setCustomDate(null); }} />
          <Pill label="Todos" active={timeFilter === 'all'} onPress={() => { setTimeFilter('all'); setCustomDate(null); }} />
          <Pressable
            onPress={() => setShowPicker(true)}
            style={[styles.pill, timeFilter === 'custom' && styles.pillActive]}
          >
            <Ionicons
              name="calendar"
              size={14}
              color={timeFilter === 'custom' ? '#fff' : colors.primary}
            />
            {timeFilter === 'custom' && customDate ? (
              <Text style={[styles.pillText, styles.pillTextActive]}>{filterLabel}</Text>
            ) : null}
          </Pressable>
        </View>

        {showPicker ? (
          <DateTimePicker
            value={customDate || new Date()}
            mode="date"
            maximumDate={new Date()}
            display={Platform.OS === 'ios' ? 'inline' : 'default'}
            onChange={onPickDate}
          />
        ) : null}

        {/* List */}
        <Text style={styles.section}>
          {timeFilter === 'today' ? 'Actividad de hoy' :
           timeFilter === 'yesterday' ? 'Actividad de ayer' :
           timeFilter === 'week' ? 'Actividad de la semana' :
           timeFilter === 'custom' && customDate ?
             `Actividad del ${customDate.toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' })}` :
           `Actividad reciente en ${areaName || 'tu área'}`}
        </Text>
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : filteredReports.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="file-tray-outline" size={42} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Sin reportes en este periodo</Text>
            <Text style={styles.emptySub}>Cambia el filtro o crea uno nuevo.</Text>
            <View style={{ height: spacing.md }} />
            <Button
              label="Crear reporte"
              icon={<Ionicons name="add" size={16} color="#fff" />}
              onPress={() => router.push('/(especialista)/new')}
            />
          </View>
        ) : (
          filteredReports.map((r) => <ReportCard key={r.id} r={r} mine={r.createdBy === user?.id} />)
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.statVal}>{value}</Text>
      <Text style={styles.statLbl}>{label}</Text>
    </View>
  );
}

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.pill, active && styles.pillActive]}
      hitSlop={6}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function ReportCard({ r, mine }: { r: Report; mine: boolean }) {
  const thumb = r.images?.[0];
  return (
    <Pressable
      onPress={() => router.push(`/(especialista)/report/${r.id}`)}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
    >
      {thumb ? (
        <Image source={{ uri: thumb }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbPh]}>
          <Ionicons name="image-outline" size={22} color={colors.textMuted} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <View style={styles.cardTop}>
          <AreaChip name={r.areaName} />
          <Text style={styles.time}>{fmtTime(r.createdAt)}</Text>
        </View>
        <Text style={styles.title} numberOfLines={1}>{r.title}</Text>
        {r.comments ? <Text style={styles.comments} numberOfLines={2}>{r.comments}</Text> : null}
        <View style={styles.cardFoot}>
          <View style={styles.byRow}>
            <Ionicons name={mine ? 'person-circle' : 'people'} size={13} color={mine ? colors.primary : colors.textMuted} />
            <Text style={[styles.by, mine && { color: colors.primary, fontWeight: '800' }]}>
              {mine ? 'Tú' : r.createdByName}
            </Text>
          </View>
          <View style={styles.byRow}>
            <Ionicons name="images-outline" size={13} color={colors.textMuted} />
            <Text style={styles.by}>{r.images?.length || 0}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.sm },
  banner: {
    backgroundColor: colors.primary,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  bannerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  bannerIcon: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  bannerLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  bannerArea: { color: '#fff', fontSize: 18, fontWeight: '900', marginTop: 2 },
  bannerCta: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
  },
  bannerCtaText: { color: '#fff', fontWeight: '800', fontSize: 13 },

  queueCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#FEF3C7',
    borderWidth: 1, borderColor: '#FCD34D',
    borderRadius: radius.md,
    padding: spacing.md,
  },
  queueTitle: { color: '#92400E', fontWeight: '800', fontSize: 13 },
  queueSub: { color: '#92400E', fontSize: 11, marginTop: 2 },
  queueBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },

  stats: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.sm + 2,
    alignItems: 'flex-start',
    gap: 2,
  },
  statVal: { fontSize: 20, fontWeight: '900', color: colors.text, marginTop: 2 },
  statLbl: { fontSize: 10, color: colors.textMuted, fontWeight: '700' },

  section: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.md },
  center: { padding: spacing.lg, alignItems: 'center' },
  empty: { alignItems: 'center', padding: spacing.lg, gap: 4 },
  emptyTitle: { fontWeight: '800', color: colors.text, fontSize: 15, marginTop: spacing.sm },
  emptySub: { color: colors.textMuted, fontSize: 13 },

  card: {
    flexDirection: 'row',
    gap: spacing.sm + 4,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.sm + 4,
    marginTop: spacing.sm,
  },
  thumb: { width: 72, height: 72, borderRadius: radius.md, backgroundColor: colors.border },
  thumbPh: { alignItems: 'center', justifyContent: 'center' },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  time: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  title: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: 4 },
  comments: { fontSize: 12, color: colors.textBody, marginTop: 2 },
  cardFoot: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  byRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  by: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },

  pillsRow: {
    flexDirection: 'row', gap: 6, flexWrap: 'wrap',
    marginTop: spacing.sm,
  },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { fontSize: 12, fontWeight: '800', color: colors.textBody },
  pillTextActive: { color: '#fff' },
});
