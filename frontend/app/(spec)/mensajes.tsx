// SynCo v2.0 — Tab "Mensajes" — Chat por proyecto.
// Pull/polling cada 6s con delta-fetch usando `since`.
// Render: lista invertida (FlatList inverted), input pegado abajo, header azul corporativo.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, AppStateStatus, FlatList, KeyboardAvoidingView,
  Platform, Pressable, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/src/auth-context';
import { api, Message } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';
import { confirm } from '@/src/utils/confirm';

const POLL_MS = 6000;

export default function MensajesScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const projectId = (user?.project_ids || [])[0] || '';
  const myId = user?.id || '';
  const isCoord = user?.role === 'coordinador_general';

  const [items, setItems] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastIsoRef = useRef<string | null>(null);

  const loadInitial = useCallback(async () => {
    if (!projectId) { setLoading(false); setError('Sin proyecto asignado'); return; }
    try {
      setError(null);
      const data = await api.listMessages(projectId, { limit: 100 });
      setItems(data);
      lastIsoRef.current = data.length ? data[data.length - 1].created_at : null;
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar los mensajes');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const pollDelta = useCallback(async () => {
    if (!projectId) return;
    try {
      const data = await api.listMessages(projectId, {
        since: lastIsoRef.current || undefined,
        limit: 200,
      });
      if (data.length) {
        setItems((prev) => {
          const seen = new Set(prev.map((m) => m.id));
          const fresh = data.filter((m) => !seen.has(m.id));
          if (!fresh.length) return prev;
          const next = [...prev, ...fresh];
          lastIsoRef.current = next[next.length - 1].created_at;
          return next;
        });
      }
    } catch {/* silencioso */}
  }, [projectId]);

  useEffect(() => { loadInitial(); }, [loadInitial]);

  useEffect(() => {
    function start() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => { pollDelta(); }, POLL_MS);
    }
    function stop() {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    start();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') { pollDelta(); start(); } else { stop(); }
    });
    return () => { stop(); sub.remove(); };
  }, [pollDelta]);

  async function onSend() {
    const t = text.trim();
    if (!t || sending) return;
    try {
      setSending(true);
      setError(null);
      const created = await api.sendMessage(projectId, t);
      setText('');
      setItems((prev) => {
        if (prev.some((m) => m.id === created.id)) return prev;
        const next = [...prev, created];
        lastIsoRef.current = created.created_at;
        return next;
      });
    } catch (e: any) {
      setError(e?.message || 'No se pudo enviar');
    } finally {
      setSending(false);
    }
  }

  async function onLongPress(m: Message) {
    if (!(m.user_id === myId || isCoord)) return;
    const ok = await confirm(
      'Eliminar mensaje',
      '¿Eliminar este mensaje? Esta acción no se puede deshacer.',
      { confirmText: 'Eliminar', destructive: true },
    );
    if (!ok) return;
    try {
      await api.deleteMessage(m.id);
      setItems((prev) => prev.filter((x) => x.id !== m.id));
    } catch (e: any) {
      setError(e?.message || 'No se pudo eliminar');
    }
  }

  // Para FlatList inverted necesitamos invertir el orden.
  const dataInverted = useMemo(() => [...items].reverse(), [items]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
    >
      <StatusBar barStyle="light-content" />
      <View style={[styles.blueHeader, { paddingTop: insets.top + spacing.xs }]}>
        <View style={styles.headerIcon}>
          <Ionicons name="chatbubbles" size={18} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Mensajes</Text>
          <Text style={styles.headerSubtitle}>Chat general del proyecto · pull cada 6 s</Text>
        </View>
        <Pressable onPress={() => { loadInitial(); }} hitSlop={10} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={18} color="#fff" />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centerPad}><ActivityIndicator color={colors.primary} /></View>
      ) : items.length === 0 && !error ? (
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIcon}>
            <Ionicons name="chatbubbles-outline" size={28} color={colors.primary} />
          </View>
          <Text style={styles.emptyTitle}>Aún no hay mensajes</Text>
          <Text style={styles.emptyMsg}>
            Inicia la conversación con tu equipo del proyecto.
          </Text>
        </View>
      ) : (
        <FlatList
          data={dataInverted}
          keyExtractor={(m) => m.id}
          inverted
          contentContainerStyle={{ paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm, gap: 6 }}
          renderItem={({ item, index }) => {
            const prev = dataInverted[index + 1]; // anterior cronológico (lista invertida)
            const isMine = item.user_id === myId;
            const sameAuthor = prev && prev.user_id === item.user_id;
            const showAuthor = !isMine && !sameAuthor;
            return (
              <Bubble
                item={item}
                isMine={isMine}
                showAuthor={showAuthor}
                onLongPress={() => onLongPress(item)}
              />
            );
          }}
        />
      )}

      {error ? (
        <View style={styles.errorBar}>
          <Ionicons name="alert-circle-outline" size={14} color={colors.error} />
          <Text style={styles.errorBarTxt}>{error}</Text>
          <Pressable onPress={() => setError(null)} hitSlop={8}>
            <Ionicons name="close" size={14} color={colors.error} />
          </Pressable>
        </View>
      ) : null}

      <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Escribe un mensaje…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          multiline
          maxLength={2000}
          editable={!sending}
          onSubmitEditing={onSend}
          blurOnSubmit={false}
        />
        <Pressable
          onPress={onSend}
          disabled={!text.trim() || sending}
          style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.5 }]}
        >
          {sending
            ? <ActivityIndicator color="#fff" size="small" />
            : <Ionicons name="send" size={18} color="#fff" />}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

// ============================================================================
function Bubble({
  item, isMine, showAuthor, onLongPress,
}: {
  item: Message; isMine: boolean; showAuthor: boolean; onLongPress: () => void;
}) {
  return (
    <View style={[styles.row, isMine ? styles.rowRight : styles.rowLeft]}>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={400}
        style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleOther,
        ]}
      >
        {showAuthor ? (
          <View style={styles.authorRow}>
            <Text style={styles.authorName} numberOfLines={1}>{item.user_name}</Text>
            <View style={styles.roleChip}>
              <Text style={styles.roleChipTxt}>{shortRole(item.user_role)}</Text>
            </View>
          </View>
        ) : null}
        <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{item.text}</Text>
        <Text style={[styles.timestamp, isMine && styles.timestampMine]}>
          {formatTime(item.created_at)}
        </Text>
      </Pressable>
    </View>
  );
}

function shortRole(r: string): string {
  if (r === 'coordinador_general') return 'Coordinador';
  if (r === 'sub_coordinador') return 'Sub-Coord.';
  if (r === 'especialista') return 'Especialista';
  return r;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  if (same) return time;
  return `${d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' })} · ${time}`;
}

const styles = StyleSheet.create({
  blueHeader: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.primary,
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

  centerPad: { padding: spacing.xl, alignItems: 'center' },

  emptyWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 6,
  },
  emptyIcon: {
    width: 64, height: 64, borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  emptyMsg: { fontSize: 12, color: colors.textBody, textAlign: 'center', lineHeight: 18, paddingHorizontal: 20 },

  row: { flexDirection: 'row', maxWidth: '100%' },
  rowLeft: { justifyContent: 'flex-start' },
  rowRight: { justifyContent: 'flex-end' },

  bubble: {
    maxWidth: '82%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    ...shadow.card,
  },
  bubbleMine: {
    backgroundColor: colors.primary,
    borderBottomRightRadius: 4,
  },
  bubbleOther: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  authorName: { fontSize: 11, fontWeight: '800', color: colors.primary, maxWidth: 140 },
  roleChip: {
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.full,
  },
  roleChipTxt: { fontSize: 9, fontWeight: '800', color: colors.primary, letterSpacing: 0.3 },

  bubbleText: { fontSize: 14, color: colors.text, lineHeight: 19 },
  bubbleTextMine: { color: '#fff' },
  timestamp: { fontSize: 10, color: colors.textMuted, marginTop: 4, alignSelf: 'flex-end' },
  timestampMine: { color: 'rgba(255,255,255,0.75)' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },

  errorBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.errorBg,
    paddingHorizontal: spacing.md, paddingVertical: 8,
  },
  errorBarTxt: { color: colors.error, fontSize: 12, fontWeight: '700', flex: 1 },
});
