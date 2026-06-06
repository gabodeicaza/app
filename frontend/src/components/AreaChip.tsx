import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { areaTone } from '@/src/theme';

export function AreaChip({ name, color }: { name: string; color?: string }) {
  const t = areaTone(color);
  return (
    <View style={[styles.chip, { backgroundColor: t.bg, borderColor: t.border }]}>
      <View style={[styles.dot, { backgroundColor: t.text }]} />
      <Text style={[styles.text, { color: t.text }]} numberOfLines={1}>{name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontSize: 12, fontWeight: '700' },
});
