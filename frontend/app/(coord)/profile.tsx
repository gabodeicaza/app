import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/src/auth-context';
import { Button } from '@/src/components/Button';
import { colors, radius, spacing } from '@/src/theme';
import { roleLabel } from '@/src/utils/roles';
import { confirm } from '@/src/utils/confirm';

export default function CoordProfile() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  async function onLogout() {
    const ok = await confirm('Cerrar sesión', '¿Seguro que deseas salir?', { confirmText: 'Cerrar sesión', destructive: true });
    if (!ok) return;
    await logout();
    router.replace('/(auth)/login');
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.title}>Mi perfil</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.profileCard}>
          <View style={styles.bigAvatar}>
            <Text style={styles.bigAvatarText}>{(user?.name?.[0] || 'C').toUpperCase()}</Text>
          </View>
          <Text style={styles.name}>{user?.name}</Text>
          <Text style={styles.email}>{user?.email}</Text>
          <View style={styles.roleBadge}>
            <Ionicons name="shield-checkmark" size={14} color={colors.primary} />
            <Text style={styles.roleBadgeText}>{roleLabel(user?.role, user?.area)}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardLabel}>Cuenta</Text>
          <Row icon="mail-outline" label="Correo" value={user?.email || '—'} />
          <Row icon="shield-outline" label="Rol" value={roleLabel(user?.role)} />
          <Row icon="folder-outline" label="Proyectos accesibles" value={user?.role === 'coordinador_general' ? 'Todos (god mode)' : String(user?.project_ids?.length ?? 0)} />
        </View>

        <Button label="Cerrar sesión" variant="danger" onPress={onLogout} fullWidth />
      </ScrollView>
    </View>
  );
}

function Row({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={18} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: colors.text },
  scroll: { paddingHorizontal: spacing.lg, gap: spacing.md },
  profileCard: { alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, gap: 6, borderWidth: 1, borderColor: colors.border },
  bigAvatar: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  bigAvatarText: { color: colors.textInverse, fontWeight: '900', fontSize: 32 },
  name: { fontSize: 19, fontWeight: '900', color: colors.text, marginTop: 8 },
  email: { fontSize: 13, color: colors.textMuted, fontWeight: '600' },
  roleBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.primaryLight, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full, marginTop: 8 },
  roleBadgeText: { fontSize: 12, fontWeight: '800', color: colors.primary },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  cardLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  rowLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  rowValue: { fontSize: 14, color: colors.text, fontWeight: '700' },
});
