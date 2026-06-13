import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView, Alert,
  ActivityIndicator, Platform, KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { ReadOnlyGuard } from '@/src/components/ReadOnlyGuard';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

export default function ProyectoSettings() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [contract, setContract] = useState('');
  const [contractor, setContractor] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedBy, setSavedBy] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const cfg = await api.getSiteConfig();
      setContract(cfg.contract || '');
      setContractor(cfg.contractor || '');
      setSavedAt(cfg.updatedAt || null);
      setSavedBy(cfg.updatedBy || null);
    } catch (e: any) {
      Alert.alert('Error al cargar', e?.message || 'Error');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function onSave() {
    setSaving(true);
    try {
      const u = await api.updateSiteConfig({
        contract: contract.trim(),
        contractor: contractor.trim(),
      });
      setContract(u.contract || '');
      setContractor(u.contractor || '');
      setSavedAt(u.updatedAt || null);
      setSavedBy(u.updatedBy || null);
      Alert.alert('Guardado', 'Configuración del proyecto actualizada.');
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Error');
    } finally { setSaving(false); }
  }

  const lastUpdate = useMemo(() => {
    if (!savedAt) return null;
    try { return new Date(savedAt).toLocaleString(); } catch { return savedAt; }
  }, [savedAt]);

  if (loading) {
    return (
      <ReadOnlyGuard title="Datos del proyecto">
      <View style={styles.flex}>
        <AppHeader title="Datos del proyecto" back />
        <View style={styles.center}><ActivityIndicator color={colors.primary} size="large" /></View>
      </View>
      </ReadOnlyGuard>
    );
  }

  return (
    <ReadOnlyGuard title="Datos del proyecto">
    <View style={styles.flex}>
      <AppHeader title="Datos del proyecto" subtitle="Variables globales del contrato" back />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text style={styles.cardHint}>
              Se aplican automáticamente en los encabezados de cada reporte.
            </Text>

            <Text style={styles.label}>Número de contrato</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="pricetag-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={contract} onChangeText={setContract}
                placeholder="Ej. CT-2025-0142"
                placeholderTextColor={colors.textMuted}
                style={styles.input} autoCapitalize="characters"
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Contratista</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="business-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={contractor} onChangeText={setContractor}
                placeholder="Ej. Constructora ACME S.A."
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>

            {lastUpdate ? (
              <Text style={styles.meta}>
                Última actualización: {lastUpdate}{savedBy ? ` · por ${savedBy}` : ''}
              </Text>
            ) : null}

            <View style={{ height: spacing.md }} />
            <Button
              label="Guardar configuración"
              onPress={onSave}
              loading={saving}
              icon={<Ionicons name="save-outline" size={18} color={colors.textInverse} />}
              fullWidth
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
    </ReadOnlyGuard>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  cardHint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 16 },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingHorizontal: 12, backgroundColor: colors.surface,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text },
  meta: { marginTop: spacing.sm, fontSize: 11, color: colors.textMuted, fontStyle: 'italic' },
});
