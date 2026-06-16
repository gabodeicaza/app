// SynCo v2.0 — Administración de Noticias (Coordinador General).
// CRUD completo con fijado, editar y eliminar.
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable,
  RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, Announcement } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';

type Editing = { id?: string; title: string; body: string; pinned: boolean } | null;

export default function CoordAnnouncementsScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = (Array.isArray(id) ? id[0] : id) || '';

  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const data = await api.listAnnouncements(pid);
      setItems(data);
    } catch (e: any) {
      setError(e?.message || 'Error al cargar');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [pid]);

  useFocusEffect(useCallback(() => { load(false); }, [load]));

  async function onSave() {
    if (!editing) return;
    const t = editing.title.trim();
    const b = editing.body.trim();
    if (!t) { setError('Título requerido'); return; }
    if (!b) { setError('Cuerpo requerido'); return; }
    try {
      setSaving(true);
      setError(null);
      if (editing.id) {
        await api.updateAnnouncement(editing.id, { title: t, body: b, pinned: editing.pinned });
      } else {
        await api.createAnnouncement(pid, { title: t, body: b, pinned: editing.pinned });
      }
      setEditing(null);
      await load(true);
    } catch (e: any) {
      setError(e?.message || 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  async function onTogglePin(a: Announcement) {
    try {
      await api.updateAnnouncement(a.id, { pinned: !a.pinned });
      await load(true);
    } catch (e: any) {
      setError(e?.message || 'No se pudo actualizar');
    }
  }

  async function onDelete(a: Announcement) {
    const ok = await confirm(
      'Eliminar noticia',
      `¿Eliminar "${a.title}"? Esta acción no se puede deshacer.`,
      { confirmText: 'Eliminar', destructive: true },
    );
    if (!ok) return;
    try {
      await api.deleteAnnouncement(a.id);
      await load(true);
    } catch (e: any) {
      setError(e?.message || 'No se pudo eliminar');
    }
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>Noticias</Text>
          <Text style={styles.subtitle}>Anuncios visibles para todo el proyecto</Text>
        </View>
        <Pressable
          onPress={() => setEditing({ title: '', body: '', pinned: false })}
          style={styles.newBtn}
        >
          <Ionicons name="add" size={18} color="#fff" />
          <Text style={styles.newBtnTxt}>Nueva</Text>
        </Pressable>
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
              <Ionicons name="newspaper-outline" size={26} color={colors.primary} />
            </View>
            <Text style={styles.emptyTitle}>Sin noticias publicadas</Text>
            <Text style={styles.emptyMsg}>
              Publica anuncios visibles para Sub-Coordinadores y Especialistas del proyecto.
            </Text>
            <Pressable style={styles.emptyBtn} onPress={() => setEditing({ title: '', body: '', pinned: false })}>
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.emptyBtnTxt}>Publicar primera</Text>
            </Pressable>
          </View>
        ) : (
          items.map((a) => (
            <View key={a.id} style={[styles.card, a.pinned && styles.cardPinned]}>
              <View style={styles.cardTopRow}>
                <Pressable style={styles.pinChip} onPress={() => onTogglePin(a)}>
                  <Ionicons
                    name={a.pinned ? 'pin' : 'pin-outline'}
                    size={12}
                    color={a.pinned ? colors.primary : colors.textMuted}
                  />
                  <Text style={[styles.pinChipTxt, a.pinned && { color: colors.primary }]}>
                    {a.pinned ? 'Fijado' : 'Fijar'}
                  </Text>
                </Pressable>
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Pressable
                    onPress={() => setEditing({ id: a.id, title: a.title, body: a.body, pinned: a.pinned })}
                    style={styles.iconAction}
                  >
                    <Ionicons name="create-outline" size={16} color={colors.primary} />
                  </Pressable>
                  <Pressable onPress={() => onDelete(a)} style={[styles.iconAction, { backgroundColor: colors.errorBg }]}>
                    <Ionicons name="trash-outline" size={16} color={colors.error} />
                  </Pressable>
                </View>
              </View>
              <Text style={styles.cardTitle}>{a.title}</Text>
              <Text style={styles.cardBody}>{a.body}</Text>
              <View style={styles.cardMeta}>
                <Ionicons name="person-outline" size={11} color={colors.textMuted} />
                <Text style={styles.cardMetaTxt}>{a.author_name}</Text>
                <Text style={styles.cardMetaDot}>·</Text>
                <Ionicons name="time-outline" size={11} color={colors.textMuted} />
                <Text style={styles.cardMetaTxt}>{new Date(a.created_at).toLocaleString('es-MX')}</Text>
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
            <Text style={styles.modalTitle}>
              {editing?.id ? 'Editar noticia' : 'Nueva noticia'}
            </Text>
            <ScrollView contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }} keyboardShouldPersistTaps="handled">
              <View>
                <Text style={styles.label}>Título</Text>
                <TextInput
                  value={editing?.title || ''}
                  onChangeText={(t) => setEditing((e) => e ? { ...e, title: t } : e)}
                  placeholder="Ej. Cierre Tramo 2 sábado"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  maxLength={140}
                />
                <Text style={styles.helper}>{(editing?.title || '').length} / 140</Text>
              </View>
              <View>
                <Text style={styles.label}>Contenido</Text>
                <TextInput
                  value={editing?.body || ''}
                  onChangeText={(t) => setEditing((e) => e ? { ...e, body: t } : e)}
                  placeholder="Describe la noticia. Las saltos de línea se respetan."
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.inputArea]}
                  multiline
                  maxLength={4000}
                  textAlignVertical="top"
                />
                <Text style={styles.helper}>{(editing?.body || '').length} / 4000</Text>
              </View>
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Fijar al inicio</Text>
                  <Text style={styles.helper}>Aparecerá arriba del feed para todos los miembros del proyecto.</Text>
                </View>
                <Switch
                  value={!!editing?.pinned}
                  onValueChange={(v) => setEditing((e) => e ? { ...e, pinned: v } : e)}
                  trackColor={{ true: colors.primary, false: colors.border }}
                  thumbColor="#fff"
                />
              </View>
              {error ? <Text style={[styles.errorText, { textAlign: 'center' }]}>{error}</Text> : null}
            </ScrollView>
            <View style={styles.modalActions}>
              <Pressable onPress={() => { setEditing(null); setError(null); }} style={[styles.btn, styles.btnGhost]}>
                <Text style={styles.btnGhostTxt}>Cancelar</Text>
              </Pressable>
              <Pressable onPress={onSave} disabled={saving} style={[styles.btn, styles.btnPrimary, saving && { opacity: 0.6 }]}>
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryTxt}>{editing?.id ? 'Guardar' : 'Publicar'}</Text>}
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  scroll: { paddingHorizontal: spacing.md, gap: spacing.sm },
  center: { padding: spacing.xl, alignItems: 'center' },

  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, gap: 6, ...shadow.card,
  },
  cardPinned: { borderColor: colors.primary, borderWidth: 1.5 },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pinChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
  },
  pinChipTxt: { fontSize: 11, fontWeight: '700', color: colors.textMuted },
  iconAction: {
    width: 28, height: 28, borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  cardBody: { fontSize: 13, color: colors.textBody, lineHeight: 20 },
  cardMeta: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    marginTop: 4, paddingTop: 8, borderTopColor: colors.border, borderTopWidth: 1,
  },
  cardMetaTxt: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  cardMetaDot: { fontSize: 11, color: colors.textMuted, marginHorizontal: 2 },

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
    padding: spacing.md,
    paddingBottom: spacing.lg,
    maxHeight: '90%',
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
  inputArea: { minHeight: 120 },
  helper: { fontSize: 11, color: colors.textMuted, marginTop: 4 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  btn: { flex: 1, paddingVertical: 12, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  btnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  btnGhostTxt: { color: colors.text, fontWeight: '800', fontSize: 14 },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
