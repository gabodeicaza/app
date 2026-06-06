import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/src/theme';
import { useSync } from '@/src/sync-context';

export function ConnectionPill() {
  const { online, syncing, pendingCount } = useSync();
  const bg = !online ? colors.offline : syncing ? colors.syncing : colors.online;
  const label = !online
    ? `Offline${pendingCount ? ` · ${pendingCount}` : ''}`
    : syncing
      ? `Sincronizando${pendingCount ? ` · ${pendingCount}` : ''}`
      : pendingCount
        ? `Pendiente · ${pendingCount}`
        : 'En línea';
  return (
    <View style={[styles.pill, { backgroundColor: bg + '22', borderColor: bg }]}>
      {syncing ? (
        <ActivityIndicator size="small" color={bg} />
      ) : (
        <Ionicons
          name={online ? 'cloud-done-outline' : 'cloud-offline-outline'}
          size={14}
          color={bg}
        />
      )}
      <Text style={[styles.pillText, { color: bg }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 12, fontWeight: '700' },
});
