import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { EditProfileModal } from '@/src/components/EditProfileModal';
import { useAuth } from '@/src/auth-context';
import { useSync } from '@/src/sync-context';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

const PUESTO_SUGGESTIONS_BY_AREA: Record<string, string[]> = {
  geotecnia: ['Ingeniero(a) Geotécnico', 'Laboratorista', 'Asistente Geotécnico'],
  topografia: ['Topógrafo Senior', 'Cadenero', 'Asistente Topográfico'],
  obracivil: ['Residente de Obra', 'Maestro de Obra', 'Auxiliar de Obra'],
  seguridad: ['Supervisor HSE', 'Inspector de Seguridad', 'Brigadista'],
  calidad: ['Inspector(a) de Calidad', 'Aseguramiento de Calidad', 'Laboratorista QA/QC'],
};

export default function EspProfile() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const { pendingCount, online } = useSync();
  const [areaName, setAreaName] = useState<string>('');
  const [editOpen, setEditOpen] = useState(false);

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
          {user?.puesto ? (
            <Text style={styles.puestoLine}>{user.puesto}</Text>
          ) : null}
          <Text style={styles.email}>{user?.email}</Text>
          <Pressable onPress={() => setEditOpen(true)} style={styles.editBtn}>
            <Ionicons name="create-outline" size={14} color={colors.primary} />
            <Text style={styles.editBtnText}>Editar perfil</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cuenta</Text>
          <Row icon="id-card-outline" label="ID" value={user?.id?.slice(0, 8)} />
          <Row icon="mail-outline" label="Email" value={user?.email} />
          <Row icon="shield-checkmark-outline" label="Rol" value="Especialista" />
          <Row icon="hammer-outline" label="Área" value={areaName || '—'} />
          <Row icon="briefcase-outline" label="Puesto" value={user?.puesto || '—'} />
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
      <EditProfileModal
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        suggestions={(user?.area && PUESTO_SUGGESTIONS_BY_AREA[user.area]) || []}
      />
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
  puestoLine: { fontSize: 13, fontWeight: '700', color: colors.textBody, marginTop: 6 },
  email: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  editBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    marginTop: spacing.sm,
  },
  editBtnText: { fontSize: 12, fontWeight: '800', color: colors.primary },
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
