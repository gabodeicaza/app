import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { AppHeader } from '@/src/components/AppHeader';
import { colors, radius, shadow, spacing } from '@/src/theme';

export default function CoordSettingsHub() {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.flex}>
      <AppHeader title="Configuración" subtitle="Gestión del proyecto SynCo" />
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.section}>Proyecto</Text>
        <Item
          icon="document-text"
          tint={colors.primary}
          title="Datos del proyecto"
          subtitle="Número de contrato, contratista y variables globales."
          onPress={() => router.push('/(coordinador)/settings/proyecto' as any)}
        />
        <Item
          icon="location"
          tint="#059669"
          title="Puntos de referencia"
          subtitle="Postes / hitos para autocompletar ubicación en reportes."
          onPress={() => router.push('/(coordinador)/settings/puntos' as any)}
        />
        <Item
          icon="grid"
          tint="#D97706"
          title="Áreas de trabajo"
          subtitle="Topografía, Geotecnia, Estructuras y demás."
          onPress={() => router.push('/(coordinador)/areas' as any)}
        />

        <Text style={[styles.section, { marginTop: spacing.lg }]}>Mi cuenta</Text>
        <Item
          icon="person-circle"
          tint="#7C3AED"
          title="Perfil del Supervisor"
          subtitle="Editar datos personales y cerrar sesión."
          onPress={() => router.push('/(coordinador)/profile' as any)}
        />
      </ScrollView>
    </View>
  );
}

function Item({ icon, tint, title, subtitle, onPress }: {
  icon: any; tint: string; title: string; subtitle: string; onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}>
      <View style={[styles.iconBox, { backgroundColor: tint + '22' }]}>
        <Ionicons name={icon} size={22} color={tint} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{subtitle}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.sm },
  section: { fontSize: 13, fontWeight: '900', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: spacing.sm, marginBottom: 4, paddingHorizontal: 4 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...shadow.card,
  },
  iconBox: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '800', color: colors.text },
  sub: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
});
