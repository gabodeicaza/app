import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors, spacing } from '@/src/theme';
import { ConnectionPill } from './StatusBadge';
import { useAuth } from '@/src/auth-context';

interface Props {
  title: string;
  subtitle?: string;
  back?: boolean;
  right?: React.ReactNode;
  /** Si es false, no muestra el atajo a Perfil (p.ej. en la propia pantalla Perfil) */
  showProfile?: boolean;
}

export function AppHeader({ title, subtitle, back, right, showProfile = true }: Props) {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();

  function goProfile() {
    if (!user) return;
    const path = user.role === 'coordinador' ? '/(coordinador)/profile' : '/(especialista)/profile';
    router.push(path as any);
  }

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <View style={styles.row}>
        <View style={styles.leftRow}>
          {back ? (
            <Pressable onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={24} color={colors.text} />
            </Pressable>
          ) : null}
          <View style={{ flexShrink: 1 }}>
            <Text numberOfLines={1} style={styles.title}>{title}</Text>
            {subtitle ? <Text numberOfLines={1} style={styles.subtitle}>{subtitle}</Text> : null}
          </View>
        </View>
        <View style={styles.rightRow}>
          {right}
          <ConnectionPill />
          {showProfile && user ? (
            <Pressable
              onPress={goProfile}
              hitSlop={8}
              style={styles.avatarBtn}
              accessibilityLabel="Abrir perfil"
            >
              <Text style={styles.avatarTxt}>{(user.name?.[0] || '?').toUpperCase()}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm + 2,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  leftRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: 6 },
  rightRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text, letterSpacing: -0.3 },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  avatarBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarTxt: { color: '#fff', fontWeight: '900', fontSize: 13 },
});
