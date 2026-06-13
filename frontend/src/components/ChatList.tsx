import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { RoleBadge } from '@/src/components/RoleBadge';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { roleLabel } from '@/src/utils/roles';
import { colors, radius, spacing } from '@/src/theme';

interface ChatUser {
  id: string;
  name: string;
  email: string;
  role: string;
  area?: string | null;
  areaName?: string | null;
  puesto?: string | null;
  lastMessage?: string | null;
  lastAt?: string | null;
  unread: number;
}

function fmtRel(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = (+now - +d) / (1000 * 60 * 60 * 24);
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

export function ChatListScreen({ basePath }: { basePath: string }) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [users, setUsers] = useState<ChatUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const list = (await api.chatUsers()) as ChatUser[];
      setUsers(list);
    } catch {
      // soft fail
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh when screen gains focus + poll every 8s while focused.
  useFocusEffect(
    useCallback(() => {
      load();
      pollRef.current = setInterval(load, 8000);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      };
    }, [load]),
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(q) ||
        (u.areaName || '').toLowerCase().includes(q) ||
        (u.puesto || '').toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <View style={styles.flex}>
      <AppHeader title="Mensajes" subtitle={`${user?.name ?? ''}`.trim() || undefined} />

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Buscar por nombre, área o puesto…"
          placeholderTextColor={colors.textMuted}
          style={styles.searchInput}
          autoCorrect={false}
          returnKeyType="search"
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.primary}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="chatbubbles-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>Sin contactos</Text>
              <Text style={styles.emptyText}>Cuando otros usuarios se registren aparecerán aquí.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`${basePath}/chat/${item.id}` as any)}
            >
              <View style={[styles.avatar, item.unread > 0 && styles.avatarUnread]}>
                <Text style={styles.avatarTxt}>{(item.name?.[0] || '?').toUpperCase()}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <View style={styles.nameWrap}>
                    <Text style={[styles.name, item.unread > 0 && { color: colors.text }]} numberOfLines={1}>
                      {item.name}
                    </Text>
                    <RoleBadge role={item.role} />
                  </View>
                  <Text style={styles.time}>{fmtRel(item.lastAt)}</Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text
                    style={[
                      styles.preview,
                      item.unread > 0 && { color: colors.text, fontWeight: '700' },
                    ]}
                    numberOfLines={1}
                  >
                    {item.lastMessage || `${roleLabel(item.role, item.areaName)}${item.puesto ? ' · ' + item.puesto : ''}`}
                  </Text>
                  {item.unread > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeTxt}>{item.unread > 99 ? '99+' : item.unread}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surface,
    margin: spacing.md,
    marginBottom: spacing.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.surface,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarUnread: { backgroundColor: colors.primary },
  avatarTxt: { color: colors.primary, fontWeight: '900', fontSize: 18 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  nameWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 },
  name: { fontSize: 15, fontWeight: '700', color: colors.textBody, flexShrink: 1 },
  time: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  preview: { flex: 1, fontSize: 13, color: colors.textMuted },
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: '900' },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 68 },
  empty: { alignItems: 'center', padding: spacing.xl, gap: 6 },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginTop: 6 },
  emptyText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', maxWidth: 280 },
});
