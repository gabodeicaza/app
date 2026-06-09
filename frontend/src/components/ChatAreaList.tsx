import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, Pressable,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

interface Room {
  id: string;
  name: string;
  color?: string;
  icon?: string;
  lastMessage?: string | null;
  lastAt?: string | null;
  lastFrom?: string | null;
}

function fmtRel(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const diff = (+now - +d) / (1000 * 60 * 60 * 24);
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString();
  } catch { return ''; }
}

export function ChatAreaListScreen({ basePath }: { basePath: string }) {
  const insets = useSafeAreaInsets();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const list = (await api.chatAreaRooms()) as Room[];
      setRooms(list);
    } catch {} finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => {
    load();
    pollRef.current = setInterval(load, 8000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; };
  }, [load]));

  return (
    <View style={styles.flex}>
      <AppHeader title="Chat por área" subtitle="Salas grupales del proyecto" back />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} tintColor={colors.primary}
              onRefresh={() => { setRefreshing(true); load(); }} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="chatbubbles-outline" size={36} color={colors.textMuted} />
              <Text style={styles.emptyTxt}>Sin salas disponibles</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              style={styles.row}
              onPress={() => router.push(`${basePath}/chat/area/${item.id}` as any)}
            >
              <View style={[styles.icon, { backgroundColor: (item.color || colors.primary) + '22' }]}>
                <Ionicons
                  name={(item.icon as any) || 'people'}
                  size={22}
                  color={item.color || colors.primary}
                />
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.topRow}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.time}>{fmtRel(item.lastAt)}</Text>
                </View>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.lastMessage
                    ? `${item.lastFrom ? item.lastFrom + ': ' : ''}${item.lastMessage}`
                    : 'Sin mensajes aún'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
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
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: spacing.md, paddingVertical: 12,
    backgroundColor: colors.surface,
  },
  icon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { fontSize: 15, fontWeight: '800', color: colors.text, flex: 1 },
  time: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  preview: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: 68 },
  empty: { alignItems: 'center', padding: spacing.xl, gap: 6 },
  emptyTxt: { fontSize: 14, color: colors.textMuted, marginTop: 6 },
});
