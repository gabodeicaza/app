import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { fmtFullDate, fmtTime } from '@/src/utils/format';

// -- Types -------------------------------------------------------------------
interface Activity {
  id: string;
  title: string;
  description: string;
  priority: 1 | 2 | 3;
  area?: string | null;
  areaName?: string;
  createdBy: string;
  createdByName: string;
  createdByRole: string;
  createdAt: string;
}

interface Area {
  id: string;
  name: string;
  color: string;
}

type Period = 'daily' | 'weekly' | 'monthly';

type SectionItem =
  | { type: 'header'; priority: 1 | 2 | 3; count: number }
  | { type: 'item'; activity: Activity };

// -- Priority styling --------------------------------------------------------
const PRIORITY = {
  1: { label: 'Informativo', color: '#0EA5E9', bg: '#E0F2FE', icon: 'information-circle' as const },
  2: { label: 'Importante',  color: '#F59E0B', bg: '#FEF3C7', icon: 'alert-circle'       as const },
  3: { label: 'Urgente',     color: '#DC2626', bg: '#FEE2E2', icon: 'warning'            as const },
};

const PERIODS: { key: Period; label: string }[] = [
  { key: 'daily',   label: 'Día'    },
  { key: 'weekly',  label: 'Semana' },
  { key: 'monthly', label: 'Mes'    },
];

// ----------------------------------------------------------------------------
export function NoticiasScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isCoordinador = user?.role === 'coordinador';

  const [activities, setActivities] = useState<Activity[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Period filter (controla tanto la lista de noticias como el resumen IA)
  const [period, setPeriod] = useState<Period>('daily');

  // Summary state
  const [summary, setSummary] = useState<string>('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  // Create modal
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async (p: Period = period) => {
    try {
      const tzOffset = -new Date().getTimezoneOffset(); // minutos al este de UTC
      const [acts, ars] = await Promise.all([
        api.listActivities({ period: p, tzOffset }),
        api.listAreas().catch(() => [] as Area[]),
      ]);
      setActivities(acts as Activity[]);
      setAreas(ars as Area[]);
    } catch {
      // soft fail
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => { load(period); }, [period, load]);

  // Reset summary when changing period
  useEffect(() => {
    setSummary('');
    setSummaryError(null);
  }, [period]);

  const periodLabel = useMemo(() => {
    if (period === 'daily') return 'Hoy';
    if (period === 'weekly') return 'Esta semana';
    return 'Este mes';
  }, [period]);

  const onGenerateSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary('');
    try {
      const targetArea = isCoordinador ? null : (user?.area ?? null);
      const res = await api.periodSummary(period, targetArea);
      setSummary(res.summary || '');
    } catch (e: any) {
      setSummaryError(e?.message || 'No se pudo generar el resumen');
    } finally {
      setSummaryLoading(false);
    }
  }, [period, isCoordinador, user?.area]);

  const onDelete = useCallback((a: Activity) => {
    Alert.alert('Eliminar noticia', `¿Eliminar "${a.title}"?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteActivity(a.id);
            setActivities((prev) => prev.filter((x) => x.id !== a.id));
          } catch (e: any) {
            Alert.alert('Error', e?.message || 'No se pudo eliminar');
          }
        },
      },
    ]);
  }, []);

  const canDelete = useCallback(
    (a: Activity) => isCoordinador || a.createdBy === user?.id,
    [isCoordinador, user?.id]
  );

  const sections = useMemo<SectionItem[]>(() => {
    const g: Record<1 | 2 | 3, Activity[]> = { 3: [], 2: [], 1: [] };
    for (const a of activities) {
      const p = (a.priority as 1 | 2 | 3) || 1;
      g[p].push(a);
    }
    const out: SectionItem[] = [];
    ([3, 2, 1] as const).forEach((p) => {
      if (g[p].length > 0) {
        out.push({ type: 'header', priority: p, count: g[p].length });
        g[p].forEach((act) => out.push({ type: 'item', activity: act }));
      }
    });
    return out;
  }, [activities]);

  const subtitle = isCoordinador
    ? 'Noticias de todas las áreas'
    : `Tu área · ${user?.area ? (areas.find((x) => x.id === user.area)?.name || user.area) : '—'}`;

  // -- Header (period tabs + summary) ---------------------------------------
  const ListHeader = (
    <View style={{ gap: spacing.md }}>
      {/* Period tabs */}
      <View style={styles.tabsCard}>
        <Text style={styles.sectionLabel}>Resumen ejecutivo IA</Text>
        <Text style={styles.sectionMuted}>
          Generado a partir de los reportes diarios{isCoordinador ? '' : ' de tu área'}.
        </Text>
        <View style={styles.tabsRow}>
          {PERIODS.map((p) => (
            <Pressable
              key={p.key}
              onPress={() => setPeriod(p.key)}
              style={[styles.tab, period === p.key && styles.tabActive]}
            >
              <Text style={[styles.tabText, period === p.key && styles.tabTextActive]}>
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <Button
          variant="ai"
          label={summary ? 'Regenerar resumen' : 'Generar resumen'}
          loading={summaryLoading}
          onPress={onGenerateSummary}
          icon={<Ionicons name="sparkles" size={16} color="#fff" />}
          fullWidth
        />

        {summaryError ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.error} />
            <Text style={styles.errorText}>{summaryError}</Text>
          </View>
        ) : null}

        {summary ? (
          <View style={styles.summaryBox}>
            <Text style={styles.summaryText}>{summary}</Text>
          </View>
        ) : !summaryLoading ? (
          <Text style={styles.summaryHint}>
            Pulsa el botón para generar un resumen IA basado en los reportes diarios.
          </Text>
        ) : null}
      </View>

      {/* Activities header */}
      <View style={styles.row}>
        <Text style={styles.bigSection}>Para ti  ·  {periodLabel}</Text>
        <Text style={styles.sectionMuted}>{activities.length} noticias</Text>
      </View>
    </View>
  );

  // -- Render ---------------------------------------------------------------
  return (
    <View style={styles.flex}>
      <AppHeader title="Noticias" subtitle={subtitle} />

      {loading ? (
        <View style={styles.loadingFull}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={sections as SectionItem[]}
          keyExtractor={(item) =>
            item.type === 'header' ? `h-${item.priority}` : item.activity.id
          }
          ListHeaderComponent={ListHeader}
          renderItem={({ item }) => {
            if (item.type === 'header') {
              return <PrioritySectionHeader priority={item.priority} count={item.count} />;
            }
            return (
              <ActivityCard
                activity={item.activity}
                canDelete={canDelete(item.activity)}
                onDelete={() => onDelete(item.activity)}
              />
            );
          }}
          contentContainerStyle={{
            padding: spacing.md,
            paddingBottom: insets.bottom + 100,
            gap: spacing.sm,
          }}
          ItemSeparatorComponent={({ leadingItem }: any) => (
            <View style={{ height: leadingItem?.type === 'header' ? 4 : spacing.sm }} />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="newspaper-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>Sin noticias por ahora</Text>
              <Text style={styles.emptyText}>
                Crea la primera noticia con el botón inferior para mantener al equipo informado.
              </Text>
            </View>
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.primary}
              onRefresh={() => { setRefreshing(true); load(period); }}
            />
          }
        />
      )}

      {/* FAB */}
      <Pressable
        onPress={() => setModalOpen(true)}
        style={({ pressed }) => [
          styles.fab,
          { bottom: insets.bottom + 16 },
          pressed && { transform: [{ scale: 0.96 }] },
        ]}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </Pressable>

      {/* Create modal */}
      <CreateActivityModal
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(a) => {
          setModalOpen(false);
          setActivities((prev) => [a, ...prev]);
        }}
        isCoordinador={isCoordinador}
        areas={areas}
        userArea={user?.area ?? null}
      />
    </View>
  );
}

// -- Priority Section Header -------------------------------------------------
function PrioritySectionHeader({
  priority, count,
}: { priority: 1 | 2 | 3; count: number }) {
  const p = PRIORITY[priority];
  return (
    <View style={[styles.sectionHeader, { backgroundColor: p.bg, borderColor: p.color + '55' }]}>
      <View style={[styles.sectionHeaderDot, { backgroundColor: p.color }]} />
      <Ionicons name={p.icon} size={16} color={p.color} />
      <Text style={[styles.sectionHeaderTitle, { color: p.color }]}>
        Nivel {priority} · {p.label}
      </Text>
      <View style={[styles.sectionHeaderCount, { backgroundColor: p.color }]}>
        <Text style={styles.sectionHeaderCountText}>{count}</Text>
      </View>
    </View>
  );
}

// -- Activity Card -----------------------------------------------------------
function ActivityCard({
  activity, canDelete, onDelete,
}: {
  activity: Activity;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const p = PRIORITY[activity.priority] || PRIORITY[1];
  return (
    <View style={[styles.card, { borderLeftColor: p.color, backgroundColor: p.bg + '55' }]}>
      <View style={styles.cardTop}>
        <View style={[styles.badge, { backgroundColor: p.bg, borderColor: p.color + '55', borderWidth: 1 }]}>
          <Ionicons name={p.icon} size={13} color={p.color} />
          <Text style={[styles.badgeText, { color: p.color }]}>
            Nivel {activity.priority} · {p.label}
          </Text>
        </View>
        <Text style={styles.cardTime}>{fmtTime(activity.createdAt)}</Text>
      </View>

      <Text style={styles.cardTitle}>{activity.title}</Text>
      {activity.description ? (
        <Text style={styles.cardDesc}>{activity.description}</Text>
      ) : null}

      <View style={styles.cardFooter}>
        <View style={styles.cardFooterRow}>
          <Ionicons name="person-outline" size={13} color={colors.textMuted} />
          <Text style={styles.cardFooterText}>
            {activity.createdByName} · {activity.createdByRole === 'coordinador' ? 'Supervisor de Obra' : 'Especialista'}
          </Text>
        </View>
        <View style={styles.cardFooterRow}>
          <Ionicons
            name={activity.area ? 'location-outline' : 'globe-outline'}
            size={13}
            color={colors.textMuted}
          />
          <Text style={styles.cardFooterText}>{activity.areaName || 'Global'}</Text>
        </View>
        {canDelete ? (
          <Pressable onPress={onDelete} hitSlop={8} style={styles.deleteBtn}>
            <Ionicons name="trash-outline" size={14} color={colors.error} />
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.cardDate}>{fmtFullDate(activity.createdAt)}</Text>
    </View>
  );
}

// -- Create Modal ------------------------------------------------------------
function CreateActivityModal({
  visible, onClose, onCreated, isCoordinador, areas, userArea,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (a: Activity) => void;
  isCoordinador: boolean;
  areas: Area[];
  userArea: string | null;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<1 | 2 | 3>(1);
  const [selectedArea, setSelectedArea] = useState<string | null>(null); // null = global (coord only)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setTitle('');
      setDescription('');
      setPriority(1);
      setSelectedArea(isCoordinador ? null : userArea);
      setError(null);
    }
  }, [visible, isCoordinador, userArea]);

  async function submit() {
    if (!title.trim()) {
      setError('El título es obligatorio');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: title.trim(),
        description: description.trim(),
        priority,
        area: isCoordinador ? selectedArea : userArea,
      };
      const created = await api.createActivity(body);
      onCreated(created as Activity);
    } catch (e: any) {
      setError(e?.message || 'No se pudo crear la noticia');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1, justifyContent: 'flex-end' }}
        >
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nueva noticia</Text>
              <Pressable onPress={onClose} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.textBody} />
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ gap: spacing.md }}
              showsVerticalScrollIndicator={false}
            >
              <View>
                <Text style={styles.label}>Título *</Text>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="Ej. Suspensión de actividades en zona norte"
                  placeholderTextColor={colors.textMuted}
                  style={styles.textInput}
                  maxLength={120}
                />
              </View>

              <View>
                <Text style={styles.label}>Descripción</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="Detalles, motivo, horarios…"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.textInput, { minHeight: 90, textAlignVertical: 'top' }]}
                  multiline
                  maxLength={800}
                />
              </View>

              <View>
                <Text style={styles.label}>Prioridad</Text>
                <View style={styles.priorityRow}>
                  {([1, 2, 3] as const).map((lvl) => {
                    const p = PRIORITY[lvl];
                    const active = priority === lvl;
                    return (
                      <Pressable
                        key={lvl}
                        onPress={() => setPriority(lvl)}
                        style={[
                          styles.priorityChip,
                          { borderColor: p.color },
                          active && { backgroundColor: p.bg },
                        ]}
                      >
                        <Ionicons name={p.icon} size={14} color={p.color} />
                        <Text style={[styles.priorityChipText, { color: p.color }]}>
                          N{lvl} · {p.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {isCoordinador ? (
                <View>
                  <Text style={styles.label}>Área destinataria</Text>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
                  >
                    <Pressable
                      onPress={() => setSelectedArea(null)}
                      style={[
                        styles.areaChip,
                        selectedArea === null && styles.areaChipActive,
                      ]}
                    >
                      <Ionicons
                        name="globe-outline"
                        size={14}
                        color={selectedArea === null ? '#fff' : colors.primary}
                      />
                      <Text
                        style={[
                          styles.areaChipText,
                          selectedArea === null && { color: '#fff' },
                        ]}
                      >
                        Global (todas)
                      </Text>
                    </Pressable>
                    {areas.map((a) => (
                      <Pressable
                        key={a.id}
                        onPress={() => setSelectedArea(a.id)}
                        style={[
                          styles.areaChip,
                          selectedArea === a.id && styles.areaChipActive,
                        ]}
                      >
                        <View
                          style={{
                            width: 8, height: 8, borderRadius: 4,
                            backgroundColor: a.color || colors.primary,
                          }}
                        />
                        <Text
                          style={[
                            styles.areaChipText,
                            selectedArea === a.id && { color: '#fff' },
                          ]}
                        >
                          {a.name}
                        </Text>
                      </Pressable>
                    ))}
                  </ScrollView>
                </View>
              ) : (
                <View style={styles.areaHint}>
                  <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
                  <Text style={styles.areaHintText}>
                    Esta noticia se publicará en tu área.
                  </Text>
                </View>
              )}

              {error ? (
                <View style={styles.errorBox}>
                  <Ionicons name="alert-circle" size={16} color={colors.error} />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <Button label="Publicar noticia" onPress={submit} loading={busy} fullWidth />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// -- Styles ------------------------------------------------------------------
const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  loadingFull: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  // Period tabs card
  tabsCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadow.card,
  },
  sectionLabel: { fontSize: 13, fontWeight: '800', color: colors.text },
  sectionMuted: { fontSize: 12, color: colors.textMuted },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    padding: 4,
    marginTop: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: 13, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: '#fff' },
  summaryBox: {
    backgroundColor: colors.primaryLight + '40',
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primaryLight,
  },
  summaryText: { fontSize: 13, lineHeight: 19, color: colors.text },
  summaryHint: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', textAlign: 'center', marginTop: 4 },

  // Sections
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bigSection: { fontSize: 18, fontWeight: '900', color: colors.text, letterSpacing: -0.3 },

  // Priority section header (color hierarchy)
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.sm,
  },
  sectionHeaderDot: { width: 8, height: 8, borderRadius: 4 },
  sectionHeaderTitle: { flex: 1, fontSize: 13, fontWeight: '900', letterSpacing: -0.2 },
  sectionHeaderCount: {
    minWidth: 22, height: 22, paddingHorizontal: 6,
    borderRadius: 11, alignItems: 'center', justifyContent: 'center',
  },
  sectionHeaderCountText: { color: '#fff', fontSize: 11, fontWeight: '900' },

  // Activity card
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    padding: spacing.md,
    gap: 6,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeText: { fontSize: 11, fontWeight: '800' },
  cardTime: { fontSize: 12, color: colors.textMuted, fontWeight: '700' },
  cardTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 4 },
  cardDesc: { fontSize: 13, color: colors.textBody, lineHeight: 18 },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  cardFooterRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardFooterText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  cardDate: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  deleteBtn: {
    marginLeft: 'auto',
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 6,
    backgroundColor: colors.errorBg,
  },

  // Empty state
  empty: {
    alignItems: 'center',
    padding: spacing.xl,
    gap: 6,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.sm,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 6 },
  emptyText: {
    fontSize: 13, color: colors.textMuted, textAlign: 'center', maxWidth: 280, lineHeight: 18,
  },

  // FAB
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.card,
    shadowOpacity: 0.18,
    elevation: 6,
  },

  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.md,
    maxHeight: '90%',
  },
  modalHandle: {
    alignSelf: 'center',
    width: 40, height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    marginBottom: spacing.sm,
  },
  modalHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  modalTitle: { fontSize: 18, fontWeight: '900', color: colors.text },

  // Form
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  textInput: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },

  priorityRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  priorityChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1,
    paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  priorityChipText: { fontSize: 12, fontWeight: '800' },

  areaChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1, borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  areaChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  areaChipText: { fontSize: 12, fontWeight: '700', color: colors.textBody },

  areaHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.bg,
    padding: 10,
    borderRadius: radius.md,
  },
  areaHintText: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.errorBg,
    padding: 10, borderRadius: radius.md,
  },
  errorText: { color: colors.error, fontSize: 13, flex: 1, fontWeight: '600' },
});
