import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { useAuth } from '@/src/auth-context';
import { useSync } from '@/src/sync-context';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

export default function EspProfile() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { pendingCount, online } = useSync();
  const [areaName, setAreaName] = useState<string>('');

  useEffect(() => {
    (async () => {
      if (!user?.area) return;
      try {
        const areas = await api.listAreas();
        const a = areas.find((x: any) => x.id === user.area);
        if (a) setAreaName(a.name);
      } catch {}
    })();
  }, [user?.area]);

  function onLogout() {
    Alert.alert('Cerrar sesión', '¿Salir de tu cuenta?', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Salir',
        style: 'destructive',
        onPress: async () => {
          await logout();
          router.replace('/(auth)/login');
        },
      },
    ]);
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Perfil" />
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.avatarWrap}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(user?.name?.[0] || 'U').toUpperCase()}</Text>
          </View>
          <Text style={styles.name}>{user?.name}</Text>
          <View style={styles.rolePill}>
            <Ionicons name="hammer" size={12} color={colors.primary} />
            <Text style={styles.roleText}>Especialista</Text>
          </View>
          <Text style={styles.email}>{user?.email}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cuenta</Text>
          <Row icon="id-card-outline" label="ID" value={user?.id?.slice(0, 8)} />
          <Row icon="mail-outline" label="Email" value={user?.email} />
          <Row icon="shield-checkmark-outline" label="Rol" value="Especialista" />
          <Row icon="hammer-outline" label="Área" value={areaName || '—'} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Estado de sincronización</Text>
          <Row
            icon={online ? 'cloud-done-outline' : 'cloud-offline-outline'}
            label="Conexión"
            value={online ? 'En línea' : 'Sin conexión'}
          />
          <Row icon="cloud-upload-outline" label="Pendientes" value={String(pendingCount)} />
        </View>

        <Pressable onPress={onLogout} style={styles.logoutBtn}>
          <Ionicons name="log-out-outline" size={18} color={colors.error} />
          <Text style={styles.logoutText}>Cerrar sesión</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Row({ icon, label, value }: { icon: any; label: string; value?: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value || '—'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.md },
  avatarWrap: { alignItems: 'center', paddingVertical: spacing.md },
  avatar: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 36, fontWeight: '900' },
  name: { fontSize: 18, fontWeight: '900', color: colors.text, marginTop: spacing.sm },
  rolePill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, marginTop: 6,
  },
  roleText: { fontSize: 12, fontWeight: '800', color: colors.primary },
  email: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: 14, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel: { fontSize: 13, color: colors.textBody, fontWeight: '700', width: 100 },
  rowValue: { fontSize: 13, color: colors.text, flex: 1, textAlign: 'right' },
  logoutBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.errorBg,
    borderRadius: radius.md,
    paddingVertical: 14,
  },
  logoutText: { color: colors.error, fontWeight: '800', fontSize: 14 },
});
