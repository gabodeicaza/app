import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  Pressable,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { roleLabel } from '@/src/utils/roles';
import { colors, radius, spacing } from '@/src/theme';

interface Msg {
  id: string;
  from_user: string;
  from_name: string;
  to_user: string;
  to_name: string;
  text: string;
  createdAt: string;
  read: boolean;
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ChatConversationScreen({ peerId }: { peerId: string }) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [peerName, setPeerName] = useState<string>('');
  const [peerSub, setPeerSub] = useState<string>('');
  const listRef = useRef<FlatList<Msg>>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const list = (await api.chatMessages(peerId)) as Msg[];
      setMessages(list);
      // Derive peer name from first message; fall back to fetching users list
      const sample = list.find((m) => m.from_user === peerId || m.to_user === peerId);
      if (sample) {
        setPeerName(sample.from_user === peerId ? sample.from_name : sample.to_name);
      } else if (!peerName) {
        const users = (await api.chatUsers()) as any[];
        const p = users.find((u) => u.id === peerId);
        if (p) {
          setPeerName(p.name);
          setPeerSub(
            `${roleLabel(p.role, p.areaName)}${p.puesto ? ' · ' + p.puesto : ''}`,
          );
        }
      }
    } catch {
      // soft fail
    } finally {
      setLoading(false);
    }
  }, [peerId, peerName]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while focused.
  useFocusEffect(
    useCallback(() => {
      pollRef.current = setInterval(load, 4500);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      };
    }, [load]),
  );

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
    }
  }, [messages.length]);

  async function send() {
    const t = text.trim();
    if (!t || !user) return;
    setSending(true);
    try {
      const created = (await api.chatSend(peerId, t)) as Msg;
      setMessages((prev) => [...prev, created]);
      setText('');
    } catch (e: any) {
      Alert.alert('No se pudo enviar', e?.message || 'Error');
    } finally {
      setSending(false);
    }
  }

  // Group consecutive messages by same sender for tighter bubbles.
  const items = useMemo(() => messages, [messages]);

  return (
    <View style={styles.flex}>
      <AppHeader title={peerName || 'Conversación'} subtitle={peerSub} back />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 16 : 0}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => it.id}
            contentContainerStyle={[styles.list, { paddingBottom: spacing.md }]}
            renderItem={({ item, index }) => {
              const mine = item.from_user === user?.id;
              const prev = index > 0 ? items[index - 1] : null;
              const grouped = prev && prev.from_user === item.from_user;
              return (
                <View
                  style={[
                    styles.bubbleRow,
                    mine ? styles.bubbleRowRight : styles.bubbleRowLeft,
                    { marginTop: grouped ? 2 : 10 },
                  ]}
                >
                  <View
                    style={[
                      styles.bubble,
                      mine ? styles.bubbleMine : styles.bubbleTheirs,
                    ]}
                  >
                    <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>
                      {item.text}
                    </Text>
                    <Text style={[styles.bubbleTime, mine && styles.bubbleTimeMine]}>
                      {fmtTime(item.createdAt)}
                      {mine ? (item.read ? ' ✓✓' : ' ✓') : ''}
                    </Text>
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyChat}>
                <Ionicons name="chatbubble-ellipses-outline" size={36} color={colors.textMuted} />
                <Text style={styles.emptyTxt}>Empieza la conversación</Text>
              </View>
            }
          />
        )}

        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Mensaje…"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            multiline
            maxLength={2000}
            onSubmitEditing={send}
          />
          <Pressable
            onPress={send}
            disabled={sending || !text.trim()}
            style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.5 }]}
          >
            {sending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Ionicons name="send" size={18} color="#fff" />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: spacing.md, gap: 2 },
  bubbleRow: { flexDirection: 'row' },
  bubbleRowLeft: { justifyContent: 'flex-start' },
  bubbleRowRight: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  bubbleMine: { backgroundColor: colors.primary, borderBottomRightRadius: 4 },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleText: { fontSize: 14, color: colors.text, lineHeight: 19 },
  bubbleTextMine: { color: '#fff' },
  bubbleTime: { fontSize: 10, color: colors.textMuted, marginTop: 4, alignSelf: 'flex-end' },
  bubbleTimeMine: { color: '#E0E7FF' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: 10,
  },
  input: {
    flex: 1,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    maxHeight: 120,
    fontSize: 14,
    color: colors.text,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyChat: { alignItems: 'center', paddingTop: 80, gap: 6 },
  emptyTxt: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
