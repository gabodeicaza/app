// Etiqueta visual de rol al lado del nombre (Chat / Noticias).
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { roleBadgeColor, roleShortLabel } from '@/src/utils/roles';

interface Props {
  role?: string | null;
  size?: 'sm' | 'md';
}

export function RoleBadge({ role, size = 'sm' }: Props) {
  if (!role) return null;
  const c = roleBadgeColor(role);
  return (
    <View style={[
      styles.badge,
      { backgroundColor: c.bg },
      size === 'md' && styles.badgeMd,
    ]}>
      <Text style={[styles.txt, { color: c.fg }, size === 'md' && styles.txtMd]}>
        {roleShortLabel(role)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: 6, alignSelf: 'flex-start',
  },
  badgeMd: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  txt: { fontSize: 9.5, fontWeight: '900', letterSpacing: 0.3 },
  txtMd: { fontSize: 11 },
});
