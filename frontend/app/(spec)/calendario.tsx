// SynCo v2.0 — Tab "Calendario" — vista de lectura agrupada por sección temporal.
// Sin librería externa: lista limpia con secciones Hoy / Mañana / Esta semana / Más adelante.
// Cualquier miembro del proyecto puede crear eventos. Autor o Coord pueden editar/eliminar.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Platform, Pressable,
  RefreshControl, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
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

type EditorState =
  | { kind: 'create' }
  | { kind: 'edit'; item: ProjectEvent }
  | null;

export default function CalendarioScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const projectId = (user?.project_ids || [])[0] || '';
  const isCoord = user?.role === 'coordinador_general';

  const [items, setItems] = useState<ProjectEvent[]>([]);
  const [range, setRange] = useState<RangeKey>('upcoming');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);

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

  const onDelete = useCallback((it: ProjectEvent) => {
    const confirm = () => {
      api.deleteEvent(it.id).then(() => load(range, true)).catch((e) => {
        Alert.alert('Error', e?.message || 'No se pudo eliminar');
      });
    };
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof window !== 'undefined' && window.confirm('¿Eliminar este evento?')) confirm();
    } else {
      Alert.alert('Eliminar evento', '¿Seguro que deseas eliminarlo?', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: confirm },
      ]);
    }
  }, [load, range]);

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
              {section.items.map((e) => (
                <EventCard
                  key={e.id}
                  item={e}
                  canEdit={isCoord || e.author_id === user?.id}
                  onEdit={() => setEditor({ kind: 'edit', item: e })}
                  onDelete={() => onDelete(e)}
                />
              ))}
            </View>
          ))
        )}
      </ScrollView>

      <Pressable onPress={() => setEditor({ kind: 'create' })} style={[styles.fab, { bottom: insets.bottom + 16 }]}>
        <Ionicons name="add" size={26} color="#fff" />
      </Pressable>

      <EventEditor
        visible={!!editor}
        editor={editor}
        projectId={projectId}
        onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); load(range, true); }}
      />
    </View>
  );
}

function EventCard({
  item, canEdit, onEdit, onDelete,
}: {
  item: ProjectEvent;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
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
          <View style={{ flex: 1 }} />
          {canEdit ? (
            <>
              <Pressable hitSlop={8} onPress={onEdit} style={styles.iconBtn}>
                <Ionicons name="create-outline" size={15} color={colors.primary} />
              </Pressable>
              <Pressable hitSlop={8} onPress={onDelete} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={15} color={colors.error} />
              </Pressable>
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

// =====================================================================
// Modal editor de eventos. Inputs de fecha sencillos (string ISO local /
// formato YYYY-MM-DD HH:mm). El backend acepta ISO y datetime sin tz.
// =====================================================================
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function isoToLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function localInputToIso(s: string): string | null {
  const t = (s || '').trim();
  if (!t) return null;
  // Acepta "YYYY-MM-DD HH:mm" o "YYYY-MM-DDTHH:mm"
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function EventEditor({
  visible, editor, projectId, onClose, onSaved,
}: {
  visible: boolean;
  editor: EditorState;
  projectId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [loc, setLoc] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (editor?.kind === 'edit') {
      setTitle(editor.item.title);
      setDesc(editor.item.description || '');
      setLoc(editor.item.location || '');
      setStart(isoToLocalInput(editor.item.start_at));
      setEnd(isoToLocalInput(editor.item.end_at));
    } else {
      // Default a próxima hora redonda
      const d = new Date();
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
      setTitle(''); setDesc(''); setLoc('');
      setStart(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
      setEnd('');
    }
    setErr(null);
  }, [visible, editor]);

  async function submit() {
    setErr(null);
    const t = title.trim();
    if (!t) { setErr('Título obligatorio'); return; }
    const startIso = localInputToIso(start);
    if (!startIso) { setErr('Inicio inválido. Formato: YYYY-MM-DD HH:mm'); return; }
    let endIso: string | null = null;
    if (end.trim()) {
      endIso = localInputToIso(end);
      if (!endIso) { setErr('Fin inválido. Formato: YYYY-MM-DD HH:mm'); return; }
    }
    setBusy(true);
    try {
      if (editor?.kind === 'edit') {
        await api.updateEvent(editor.item.id, {
          title: t,
          description: desc.trim(),
          location: loc.trim(),
          start_at: startIso,
          end_at: endIso,
        });
      } else {
        await api.createEvent(projectId, {
          title: t,
          description: desc.trim() || undefined,
          location: loc.trim() || undefined,
          start_at: startIso,
          end_at: endIso || undefined,
        });
      }
      onSaved();
    } catch (e: any) {
      setErr(e?.message || 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'flex-end' }}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.modalHead}>
              <Text style={styles.modalTitle}>{editor?.kind === 'edit' ? 'Editar evento' : 'Nuevo evento'}</Text>
              <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color={colors.textBody} /></Pressable>
            </View>
            <ScrollView style={{ maxHeight: 480 }} contentContainerStyle={{ gap: spacing.sm }}>
              <Text style={styles.modalLabel}>Título</Text>
              <TextInput value={title} onChangeText={setTitle} placeholder="Ej. Junta de obra"
                placeholderTextColor={colors.textMuted} style={styles.modalInput} editable={!busy} maxLength={140} />
              <Text style={styles.modalLabel}>Inicio (YYYY-MM-DD HH:mm)</Text>
              <TextInput value={start} onChangeText={setStart} placeholder="2026-06-20 09:00"
                placeholderTextColor={colors.textMuted} style={styles.modalInput} editable={!busy} autoCapitalize="none" />
              <Text style={styles.modalLabel}>Fin (opcional)</Text>
              <TextInput value={end} onChangeText={setEnd} placeholder="2026-06-20 11:00"
                placeholderTextColor={colors.textMuted} style={styles.modalInput} editable={!busy} autoCapitalize="none" />
              <Text style={styles.modalLabel}>Ubicación (opcional)</Text>
              <TextInput value={loc} onChangeText={setLoc} placeholder="Frente principal"
                placeholderTextColor={colors.textMuted} style={styles.modalInput} editable={!busy} maxLength={200} />
              <Text style={styles.modalLabel}>Descripción (opcional)</Text>
              <TextInput value={desc} onChangeText={setDesc} placeholder="Detalles…"
                placeholderTextColor={colors.textMuted} style={[styles.modalInput, { minHeight: 90, textAlignVertical: 'top' }]}
                multiline editable={!busy} maxLength={2000} />
              {err ? (
                <View style={styles.errInline}>
                  <Ionicons name="alert-circle" size={14} color={colors.error} />
                  <Text style={styles.errInlineTxt}>{err}</Text>
                </View>
              ) : null}
            </ScrollView>
            <Pressable onPress={submit} style={[styles.saveBtn, busy && { opacity: 0.7 }]} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveTxt}>{editor?.kind === 'edit' ? 'Guardar cambios' : 'Crear evento'}</Text>}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
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
  iconBtn: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  fab: {
    position: 'absolute', right: 18, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    ...shadow.card,
  },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  modalCard: {
    backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    padding: spacing.md, gap: spacing.sm,
  },
  modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalTitle: { fontSize: 17, fontWeight: '800', color: colors.text },
  modalLabel: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginTop: 4 },
  modalInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: colors.text,
    backgroundColor: colors.bg,
  },
  errInline: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.errorBg, padding: 8, borderRadius: radius.sm,
  },
  errInlineTxt: { color: colors.error, fontSize: 12, fontWeight: '700' },
  saveBtn: {
    backgroundColor: colors.primary, paddingVertical: 14, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', marginTop: spacing.xs,
  },
  saveTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
