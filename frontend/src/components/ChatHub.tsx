import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { api } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';

export function ChatHub({ basePath }: { basePath: string }) {
  const insets = useSafeAreaInsets();
  const [unreadDirect, setUnreadDirect] = useState(0);
  const [rooms, setRooms] = useState<number>(0);

  const load = useCallback(async () => {
    try {
      const [u, areas] = await Promise.all([
        api.chatUnreadTotal().catch(() => ({ unread: 0 })),
        api.chatAreaRooms().catch(() => []),
      ]);
      setUnreadDirect(u.unread || 0);
      setRooms((areas as any[]).length || 0);
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { load(); }, [load]);

  return (
    <View style={styles.flex}>
      <AppHeader title="Mensajes" subtitle="Comunicación del proyecto" />
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <Card
          icon="people"
          tint={colors.primary}
          title="Chat directo"
          subtitle="Mensajes uno a uno con cualquier integrante del equipo."
          badge={unreadDirect > 0 ? String(unreadDirect) : undefined}
          onPress={() => router.push(`${basePath}/chat/directos` as any)}
        />
        <Card
          icon="chatbubbles"
          tint="#059669"
          title="Chat por área"
          subtitle="Conversaciones grupales por área de trabajo (Topografía, Geotecnia, etc.) y un canal general."
          badge={rooms > 0 ? `${rooms} salas` : undefined}
          badgeMuted
          onPress={() => router.push(`${basePath}/chat/areas` as any)}
        />
      </ScrollView>
    </View>
  );
}

function Card({
  icon, tint, title, subtitle, badge, badgeMuted, onPress,
}: {
  icon: any; tint: string; title: string; subtitle: string;
  badge?: string; badgeMuted?: boolean; onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
    >
      <View style={[styles.iconBox, { backgroundColor: tint + '22' }]}>
        <Ionicons name={icon} size={26} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.cardTopRow}>
          <Text style={styles.cardTitle}>{title}</Text>
          {badge ? (
            <View style={[styles.badge, badgeMuted ? styles.badgeMuted : { backgroundColor: tint }]}>
              <Text style={[styles.badgeTxt, badgeMuted && { color: colors.textBody }]}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.cardSub}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadow.card,
  },
  iconBox: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'space-between' },
  cardTitle: { fontSize: 16, fontWeight: '900', color: colors.text, flex: 1 },
  cardSub: { fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 17 },
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  badgeMuted: { backgroundColor: colors.border },
  badgeTxt: { color: '#fff', fontSize: 11, fontWeight: '900' },
});
