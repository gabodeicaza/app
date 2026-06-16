// SynCo v2.0 — Tab "Noticias" del Especialista / Sub-Coord.
// Cualquier miembro del proyecto puede crear noticias. El autor o el Coord
// pueden editar/eliminar. El Coord controla la fijación (pinned).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, AppStateStatus, KeyboardAvoidingView,
  Modal, Platform, Pressable, RefreshControl, ScrollView, StatusBar,
  StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/src/auth-context';
import { api, Announcement } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';

const POLL_MS = 60000;

type EditorState =
  | { kind: 'create' }
  | { kind: 'edit'; item: Announcement }
  | null;

export default function NoticiasScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const projectId = (user?.project_ids || [])[0] || '';
  const isCoord = user?.role === 'coordinador_general';

  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!projectId) { setLoading(false); setError('Sin proyecto asignado'); return; }
    try {
      if (!silent) setLoading(true);
      setError(null);
      const data = await api.listAnnouncements(projectId);
      setItems(data);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar las noticias');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    function start() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => { load(true); }, POLL_MS);
    }
    function stop() {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    start();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') { load(true); start(); } else { stop(); }
    });
    return () => { stop(); sub.remove(); };
  }, [load]);

  const onDelete = useCallback((it: Announcement) => {
    const confirm = () => {
      api.deleteAnnouncement(it.id).then(() => load(true)).catch((e) => {
        Alert.alert('Error', e?.message || 'No se pudo eliminar');
      });
    };
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-restricted-globals, no-alert
      if (typeof window !== 'undefined' && window.confirm('¿Eliminar esta noticia? Esta acción no se puede deshacer.')) confirm();
    } else {
      Alert.alert('Eliminar noticia', '¿Seguro que deseas eliminarla?', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Eliminar', style: 'destructive', onPress: confirm },
      ]);
    }
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.blueTop, { height: 140 + insets.top }]} />

      <View style={[styles.header, { paddingTop: insets.top + spacing.xs }]}>
        <View style={styles.headerIcon}>
          <Ionicons name="newspaper" size={18} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Noticias</Text>
          <Text style={styles.headerSubtitle}>Anuncios del equipo del proyecto</Text>
        </View>
        <Pressable onPress={() => load(false)} hitSlop={10} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={18} color="#fff" />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: 96, gap: spacing.sm }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(true); }}
            tintColor="#fff"
            colors={[colors.primary]}
          />
        }
      >
        {loading ? (
          <View style={styles.centerPad}><ActivityIndicator color={colors.primary} /></View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={22} color={colors.error} />
            <Text style={styles.errorTxt}>{error}</Text>
            <Pressable onPress={() => load(false)} style={styles.retryBtn}>
              <Text style={styles.retryTxt}>Reintentar</Text>
            </Pressable>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyBox}>
            <View style={styles.emptyIcon}>
              <Ionicons name="newspaper-outline" size={28} color={colors.primary} />
            </View>
            <Text style={styles.emptyTitle}>Aún no hay noticias</Text>
            <Text style={styles.emptyMsg}>
              Toca el botón “+” para publicar el primer anuncio del proyecto.
            </Text>
          </View>
        ) : (
          items.map((a) => (
            <AnnouncementCard
              key={a.id}
              item={a}
              canEdit={isCoord || a.author_id === user?.id}
              onEdit={() => setEditor({ kind: 'edit', item: a })}
              onDelete={() => onDelete(a)}
            />
          ))
        )}
      </ScrollView>

      <Pressable onPress={() => setEditor({ kind: 'create' })} style={[styles.fab, { bottom: insets.bottom + 16 }]}>
        <Ionicons name="add" size={26} color="#fff" />
      </Pressable>

      <AnnouncementEditor
        visible={!!editor}
        editor={editor}
        canPin={isCoord}
        onClose={() => setEditor(null)}
        onSaved={() => { setEditor(null); load(true); }}
        projectId={projectId}
      />
    </View>
  );
}

function AnnouncementCard({
  item, canEdit, onEdit, onDelete,
}: {
  item: Announcement;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={[styles.card, item.pinned && styles.cardPinned]}>
      {item.pinned ? (
        <View style={styles.pinnedRow}>
          <Ionicons name="pin" size={11} color={colors.primary} />
          <Text style={styles.pinnedTxt}>Fijado</Text>
        </View>
      ) : null}
      <Text style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.cardBody}>{item.body}</Text>
      <View style={styles.cardMeta}>
        <Ionicons name="person-circle-outline" size={13} color={colors.textMuted} />
        <Text style={styles.cardMetaTxt}>{item.author_name}</Text>
        <Text style={styles.cardMetaDot}>·</Text>
        <Ionicons name="time-outline" size={12} color={colors.textMuted} />
        <Text style={styles.cardMetaTxt}>{formatDate(item.created_at)}</Text>
        <View style={{ flex: 1 }} />
        {canEdit ? (
          <>
            <Pressable hitSlop={8} onPress={onEdit} style={styles.iconBtn}>
              <Ionicons name="create-outline" size={16} color={colors.primary} />
            </Pressable>
            <Pressable hitSlop={8} onPress={onDelete} style={styles.iconBtn}>
              <Ionicons name="trash-outline" size={16} color={colors.error} />
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );
}

function AnnouncementEditor({
  visible, editor, canPin, onClose, onSaved, projectId,
}: {
  visible: boolean;
  editor: EditorState;
  canPin: boolean;
  onClose: () => void;
  onSaved: () => void;
  projectId: string;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    if (editor?.kind === 'edit') {
      setTitle(editor.item.title);
      setBody(editor.item.body);
      setPinned(!!editor.item.pinned);
    } else {
      setTitle(''); setBody(''); setPinned(false);
    }
    setErr(null);
  }, [visible, editor]);

  async function submit() {
    setErr(null);
    const t = title.trim();
    const b = body.trim();
    if (!t) { setErr('Título obligatorio'); return; }
    if (!b) { setErr('Cuerpo obligatorio'); return; }
    setBusy(true);
    try {
      if (editor?.kind === 'edit') {
        const payload: any = { title: t, body: b };
        if (canPin) payload.pinned = pinned;
        await api.updateAnnouncement(editor.item.id, payload);
      } else {
        await api.createAnnouncement(projectId, { title: t, body: b, pinned: canPin ? pinned : false });
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
              <Text style={styles.modalTitle}>
                {editor?.kind === 'edit' ? 'Editar noticia' : 'Nueva noticia'}
              </Text>
              <Pressable onPress={onClose} hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textBody} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: spacing.sm }}>
              <Text style={styles.modalLabel}>Título</Text>
              <TextInput
                value={title} onChangeText={setTitle}
                placeholder="Ej. Suspensión de actividades 18-jul"
                placeholderTextColor={colors.textMuted}
                style={styles.modalInput} editable={!busy} maxLength={140}
              />
              <Text style={styles.modalLabel}>Cuerpo</Text>
              <TextInput
                value={body} onChangeText={setBody}
                placeholder="Contenido completo del anuncio…"
                placeholderTextColor={colors.textMuted}
                style={[styles.modalInput, { minHeight: 120, textAlignVertical: 'top' }]}
                multiline editable={!busy} maxLength={4000}
              />
              {canPin ? (
                <View style={styles.pinRow}>
                  <Ionicons name="pin" size={14} color={colors.primary} />
                  <Text style={styles.pinLabel}>Fijar al inicio del feed</Text>
                  <Switch value={pinned} onValueChange={setPinned} disabled={busy} />
                </View>
              ) : null}
              {err ? (
                <View style={styles.errInline}>
                  <Ionicons name="alert-circle" size={14} color={colors.error} />
                  <Text style={styles.errInlineTxt}>{err}</Text>
                </View>
              ) : null}
            </ScrollView>
            <Pressable onPress={submit} style={[styles.saveBtn, busy && { opacity: 0.7 }]} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveTxt}>{editor?.kind === 'edit' ? 'Guardar cambios' : 'Publicar'}</Text>}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diff = now - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Hace instantes';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h} h`;
  const dy = Math.floor(h / 24);
  if (dy < 7) return `Hace ${dy} d`;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  blueTop: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: colors.primary,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingBottom: spacing.md,
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
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, gap: 6, ...shadow.card,
  },
  cardPinned: { borderColor: colors.primary, borderWidth: 1.5 },
  pinnedRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  pinnedTxt: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.6, textTransform: 'uppercase' },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  cardBody: { fontSize: 13, color: colors.textBody, lineHeight: 20 },
  cardMeta: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4,
    paddingTop: 8, borderTopColor: colors.border, borderTopWidth: 1,
  },
  cardMetaTxt: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  cardMetaDot: { fontSize: 11, color: colors.textMuted, marginHorizontal: 2 },
  iconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  centerPad: { padding: spacing.xl, alignItems: 'center' },
  errorBox: {
    padding: spacing.lg, alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
  },
  errorTxt: { textAlign: 'center', color: colors.textBody, fontSize: 13 },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.md },
  retryTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  emptyBox: {
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
  // FAB
  fab: {
    position: 'absolute', right: 18, width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    ...shadow.card,
  },
  // Modal
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
  pinRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.primaryLight, padding: 10, borderRadius: radius.md,
  },
  pinLabel: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.primary },
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
