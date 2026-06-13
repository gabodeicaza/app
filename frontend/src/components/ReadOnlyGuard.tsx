import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useAuth } from '@/src/auth-context';
import { isGuestReadOnly } from '@/src/utils/roles';
import { AppHeader } from '@/src/components/AppHeader';
import { colors, radius, spacing } from '@/src/theme';

interface ReadOnlyGuardProps {
  children: React.ReactNode;
  /** Título mostrado en el header cuando se bloquea el acceso. */
  title?: string;
}

/**
 * Bloquea el contenido a roles invitados (contratista / dependencia) que
 * intenten acceder a pantallas de mutación mediante deep link o navegación
 * inesperada. Renderiza un estado “Acceso restringido” con botón para volver.
 */
export function ReadOnlyGuard({ children, title = 'Acceso restringido' }: ReadOnlyGuardProps) {
  const { user } = useAuth();
  const blocked = isGuestReadOnly(user?.role);

  if (!blocked) return <>{children}</>;

  const onBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/(coordinador)/' as any);
  };

  return (
    <View style={styles.flex}>
      <AppHeader title={title} subtitle="Vista de solo lectura" />
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Ionicons name="lock-closed" size={40} color={colors.primary} />
        </View>
        <Text style={styles.title}>Sección bloqueada</Text>
        <Text style={styles.subtitle}>
          Tu rol cuenta con permisos de solo lectura. Esta sección permite
          modificar la configuración del proyecto y está reservada para el
          equipo coordinador.
        </Text>
        <Pressable onPress={onBack} style={styles.btn}>
          <Ionicons name="arrow-back" size={16} color="#fff" />
          <Text style={styles.btnText}>Regresar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  iconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: { fontSize: 18, fontWeight: '900', color: colors.text },
  subtitle: {
    textAlign: 'center',
    color: colors.textBody,
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 320,
  },
  btn: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
