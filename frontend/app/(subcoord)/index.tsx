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

export default function SubCoordHome() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  async function onLogout() {
    const ok = await confirm('Cerrar sesión', '¿Seguro que deseas salir?', { confirmText: 'Salir', destructive: true });
    if (!ok) return;
    await logout();
    router.replace('/(auth)/login');
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.brand}>SynCo</Text>
        <Pressable onPress={onLogout} hitSlop={8}><Ionicons name="log-out-outline" size={22} color={colors.text} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.greeting}>Hola, {user?.name}</Text>
        <Text style={styles.role}>{roleLabel(user?.role)}</Text>

        <View style={styles.card}>
          <Ionicons name="construct-outline" size={36} color={colors.primary} />
          <Text style={styles.cardTitle}>Tu panel está en construcción</Text>
          <Text style={styles.cardMsg}>
            En cuanto el Coordinador General termine de configurar el árbol de nodos de tu proyecto, podrás ver el resumen y los reportes de la rama que tienes asignada.
          </Text>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Tu scope:</Text><Text style={styles.infoValue}>{user?.scope_node_id ? user.scope_node_id.slice(0, 8) + '…' : '—'}</Text></View>
          <View style={styles.infoRow}><Text style={styles.infoLabel}>Proyectos:</Text><Text style={styles.infoValue}>{user?.project_ids?.length || 0}</Text></View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  brand: { fontSize: 18, fontWeight: '900', color: colors.primary, letterSpacing: -0.4 },
  scroll: { paddingHorizontal: spacing.lg, gap: spacing.md, paddingTop: spacing.sm },
  greeting: { fontSize: 22, fontWeight: '900', color: colors.text },
  role: { fontSize: 13, color: colors.textMuted, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, gap: 10, alignItems: 'center', marginTop: spacing.md },
  cardTitle: { fontSize: 17, fontWeight: '800', color: colors.text, textAlign: 'center' },
  cardMsg: { fontSize: 13, color: colors.textMuted, textAlign: 'center', lineHeight: 19 },
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  infoLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '700' },
  infoValue: { fontSize: 12, color: colors.text, fontWeight: '800' },
});
