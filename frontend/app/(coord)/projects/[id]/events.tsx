// SynCo v2.0 — Administración de Eventos (Coordinador General).
// CRUD completo. Selección de fecha/hora con inputs nativos cuando es posible
// y fallback texto ISO en web.
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable,
  RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, ProjectEvent } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';
import { formatEventTime } from '@/src/utils/events';

interface Editing {
  id?: string;
  title: string;
  description: string;
  location: string;
  date: string;       // YYYY-MM-DD
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM (puede estar vacío)
}

function toLocalDateInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalTimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function todayDateInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function combineIso(date: string, time: string): string | null {
  if (!date) return null;
  const [y, m, d] = date.split('-').map((x) => parseInt(x, 10));
  if (!y || !m || !d) return null;
  let hh = 0, mm = 0;
  if (time) {
    const parts = time.split(':');
    hh = parseInt(parts[0] || '0', 10) || 0;
    mm = parseInt(parts[1] || '0', 10) || 0;
  }
  const local = new Date(y, m - 1, d, hh, mm, 0, 0);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

export default function CoordEventsScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = (Array.isArray(id) ? id[0] : id) || '';

  const [items, setItems] = useState<ProjectEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const data = await api.listEvents(pid, tab, 500);
      setItems(data);
    } catch (e: any) {
      setError(e?.message || 'Error al cargar');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [pid, tab]);

  useFocusEffect(useCallback(() => { load(false); }, [load]));

  function newEvent() {
    setEditing({
      title: '',
      description: '',
      location: '',
      date: todayDateInput(),
      startTime: '09:00',
      endTime: '',
    });
    setError(null);
  }

  function editEvent(e: ProjectEvent) {
    setEditing({
      id: e.id,
      title: e.title,
      description: e.description || '',
      location: e.location || '',
      date: toLocalDateInput(e.start_at),
      startTime: toLocalTimeInput(e.start_at),
      endTime: toLocalTimeInput(e.end_at || null),
    });
    setError(null);
  }

  async function onSave() {
    if (!editing) return;
    const title = editing.title.trim();
    if (!title) { setError('Título requerido'); return; }
    if (!editing.date) { setError('Fecha requerida'); return; }
    const startIso = combineIso(editing.date, editing.startTime);
    if (!startIso) { setError('Fecha/hora inicio inválida'); return; }
    const endIso = editing.endTime ? combineIso(editing.date, editing.endTime) : null;
    if (editing.endTime && !endIso) { setError('Hora fin inválida'); return; }
    if (endIso && new Date(endIso) < new Date(startIso)) {
      setError('Hora fin no puede ser anterior al inicio'); return;
    }
    try {
      setSaving(true);
      setError(null);
      const payload = {
        title,
        description: editing.description.trim() || null,
        location: editing.location.trim() || null,
        start_at: startIso,
        end_at: endIso,
      };
      if (editing.id) {
        await api.updateEvent(editing.id, payload);
      } else {
        await api.createEvent(pid, payload);
      }
      setEditing(null);
      await load(true);
    } catch (e: any) {
      setError(e?.message || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(e: ProjectEvent) {
    const ok = await confirm('Eliminar evento', `¿Eliminar "${e.title}"?`, { confirmText: 'Eliminar', destructive: true });
    if (!ok) return;
    try {
      await api.deleteEvent(e.id);
      await load(true);
    } catch (er: any) {
      setError(er?.message || 'No se pudo eliminar');
    }
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>Calendario</Text>
          <Text style={styles.subtitle}>Eventos visibles para todo el proyecto</Text>
        </View>
        <Pressable onPress={newEvent} style={styles.newBtn}>
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.newBtnTxt}>Nuevo</Text>
        </Pressable>
      </View>

      <View style={styles.tabsRow}>
        {(['upcoming', 'past'] as const).map((k) => (
          <Pressable
            key={k}
            onPress={() => { setTab(k); }}
            style={[styles.tabBtn, tab === k && styles.tabBtnActive]}
          >
            <Text style={[styles.tabTxt, tab === k && styles.tabTxtActive]}>
              {k === 'upcoming' ? 'Próximos' : 'Pasados'}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} tintColor={colors.primary} colors={[colors.primary]} />
        }
      >
        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={16} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : items.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="calendar-outline" size={26} color={colors.primary} />
            </View>
            <Text style={styles.emptyTitle}>
              {tab === 'upcoming' ? 'Sin eventos programados' : 'Sin eventos pasados'}
            </Text>
            <Text style={styles.emptyMsg}>
              Programa actividades clave del proyecto. Todos los miembros podrán verlas en su tab "Calendario".
            </Text>
            {tab === 'upcoming' ? (
              <Pressable style={styles.emptyBtn} onPress={newEvent}>
                <Ionicons name="add" size={16} color="#fff" />
                <Text style={styles.emptyBtnTxt}>Crear primer evento</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          items.map((e) => (
            <View key={e.id} style={styles.card}>
              <View style={styles.dateBlock}>
                <Text style={styles.dateDay}>{new Date(e.start_at).getDate()}</Text>
                <Text style={styles.dateMonth}>
                  {new Date(e.start_at).toLocaleDateString('es-MX', { month: 'short' }).toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.cardTitle} numberOfLines={2}>{e.title}</Text>
                <View style={styles.metaRow}>
                  <Ionicons name="time-outline" size={12} color={colors.primary} />
                  <Text style={styles.metaTxtPrimary}>{formatEventTime(e)}</Text>
                </View>
                {e.location ? (
                  <View style={styles.metaRow}>
                    <Ionicons name="location-outline" size={12} color={colors.textMuted} />
                    <Text style={styles.metaTxt} numberOfLines={1}>{e.location}</Text>
                  </View>
                ) : null}
                {e.description ? (
                  <Text style={styles.descTxt} numberOfLines={3}>{e.description}</Text>
                ) : null}
                <View style={styles.actionsRow}>
                  <Pressable onPress={() => editEvent(e)} style={[styles.actBtn]}>
                    <Ionicons name="create-outline" size={14} color={colors.primary} />
                    <Text style={styles.actBtnTxt}>Editar</Text>
                  </Pressable>
                  <Pressable onPress={() => onDelete(e)} style={[styles.actBtn, styles.actBtnDanger]}>
                    <Ionicons name="trash-outline" size={14} color={colors.error} />
                    <Text style={styles.actBtnTxtDanger}>Eliminar</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Modal visible={!!editing} animationType="slide" transparent onRequestClose={() => setEditing(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalRoot}
        >
          <View style={styles.modalBackdrop} />
          <View style={styles.modalCard}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>{editing?.id ? 'Editar evento' : 'Nuevo evento'}</Text>
            <ScrollView contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }} keyboardShouldPersistTaps="handled">
              <Field label="Título">
                <TextInput
                  value={editing?.title || ''}
                  onChangeText={(t) => setEditing((e) => e ? { ...e, title: t } : e)}
                  placeholder="Ej. Visita del Director Técnico"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  maxLength={140}
                />
              </Field>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1.2 }}>
                  <Field label="Fecha">
                    <TextInput
                      value={editing?.date || ''}
                      onChangeText={(t) => setEditing((e) => e ? { ...e, date: t } : e)}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      maxLength={10}
                      keyboardType={Platform.OS === 'web' ? 'default' : 'numbers-and-punctuation'}
                    />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Hora inicio">
                    <TextInput
                      value={editing?.startTime || ''}
                      onChangeText={(t) => setEditing((e) => e ? { ...e, startTime: t } : e)}
                      placeholder="09:00"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      maxLength={5}
                    />
                  </Field>
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Hora fin (opc.)">
                    <TextInput
                      value={editing?.endTime || ''}
                      onChangeText={(t) => setEditing((e) => e ? { ...e, endTime: t } : e)}
                      placeholder="11:30"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      maxLength={5}
                    />
                  </Field>
                </View>
              </View>
              <Field label="Ubicación (opcional)">
                <TextInput
                  value={editing?.location || ''}
                  onChangeText={(t) => setEditing((e) => e ? { ...e, location: t } : e)}
                  placeholder="Ej. Caseta principal · Tramo 2"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  maxLength={200}
                />
              </Field>
              <Field label="Descripción (opcional)">
                <TextInput
                  value={editing?.description || ''}
                  onChangeText={(t) => setEditing((e) => e ? { ...e, description: t } : e)}
                  placeholder="Detalles, agenda, asistentes esperados…"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.inputArea]}
                  multiline
                  maxLength={2000}
                  textAlignVertical="top"
                />
              </Field>
              {error ? <Text style={[styles.errorText, { textAlign: 'center' }]}>{error}</Text> : null}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable onPress={() => { setEditing(null); setError(null); }} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostTxt}>Cancelar</Text>
              </Pressable>
              <Pressable onPress={onSave} disabled={saving} style={[styles.btn, styles.btnPrimary, saving && { opacity: 0.6 }]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryTxt}>{editing?.id ? 'Guardar' : 'Programar'}</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  newBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primary, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full,
  },
  newBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 12 },

  tabsRow: {
    flexDirection: 'row', gap: 6,
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm,
  },
  tabBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  tabBtnActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  tabTxt: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  tabTxtActive: { color: '#fff' },

  scroll: { paddingHorizontal: spacing.md, gap: spacing.sm },
  center: { padding: spacing.xl, alignItems: 'center' },

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
  descTxt: { fontSize: 12, color: colors.textBody, marginTop: 6, lineHeight: 17 },
  actionsRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  actBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
  },
  actBtnTxt: { fontSize: 11, fontWeight: '800', color: colors.primary },
  actBtnDanger: { backgroundColor: colors.errorBg },
  actBtnTxtDanger: { fontSize: 11, fontWeight: '800', color: colors.error },

  empty: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg,
    alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.border, ...shadow.card,
  },
  emptyIcon: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  emptyMsg: { fontSize: 12, color: colors.textBody, textAlign: 'center', lineHeight: 18 },
  emptyBtn: {
    marginTop: spacing.sm, flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primary, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md,
  },
  emptyBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },

  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.errorBg, padding: 10, borderRadius: radius.md,
  },
  errorText: { color: colors.error, fontSize: 12, fontWeight: '700', flex: 1 },

  // Modal
  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15,23,42,0.55)' },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    padding: spacing.md, paddingBottom: spacing.lg, maxHeight: '92%',
  },
  modalHandle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, marginBottom: spacing.sm,
  },
  modalTitle: { fontSize: 17, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  label: { fontSize: 11, fontWeight: '800', color: colors.textMuted, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 },
  input: {
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: colors.text,
  },
  inputArea: { minHeight: 90 },

  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btn: { flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  btnGhostTxt: { color: colors.text, fontWeight: '800', fontSize: 14 },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
