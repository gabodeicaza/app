import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  Platform,
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { colors, radius, spacing } from '@/src/theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  suggestions?: string[];
}

export function EditProfileModal({ visible, onClose, suggestions = [] }: Props) {
  const { user, refresh } = useAuth();
  const [name, setName] = useState('');
  const [puesto, setPuesto] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setName(user?.name || '');
      setPuesto(user?.puesto || '');
      setError(null);
    }
  }, [visible, user]);

  async function onSave() {
    if (!name.trim()) {
      setError('El nombre es obligatorio');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateMe({
        name: name.trim(),
        puesto: puesto.trim() || null,
      });
      await refresh();
      onClose();
    } catch (e: any) {
      setError(e?.message || 'No se pudo actualizar el perfil');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={styles.backdropPress} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.title}>Editar perfil</Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={colors.text} />
            </Pressable>
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: spacing.lg }}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.label}>Nombre completo</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="person-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Tu nombre"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                autoCapitalize="words"
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>
              Puesto / Cargo <Text style={styles.optional}>(opcional)</Text>
            </Text>
            <View style={styles.inputWrap}>
              <Ionicons name="briefcase-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={puesto}
                onChangeText={setPuesto}
                placeholder="Ej. Residente de Obra"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                autoCapitalize="words"
              />
            </View>
            {suggestions.length > 0 ? (
              <View style={styles.suggestRow}>
                {suggestions.map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setPuesto(s)}
                    style={[styles.suggestPill, puesto === s && styles.suggestPillActive]}
                  >
                    <Text
                      style={[
                        styles.suggestText,
                        puesto === s && { color: colors.textInverse },
                      ]}
                    >
                      {s}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={{ height: spacing.lg }} />
            <Button label="Guardar cambios" loading={busy} onPress={onSave} fullWidth />
            <View style={{ height: spacing.sm }} />
            <Button label="Cancelar" variant="secondary" onPress={onClose} fullWidth />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  backdropPress: { ...StyleSheet.absoluteFillObject },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    maxHeight: '90%',
  },
  handle: {
    alignSelf: 'center',
    width: 48,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { fontSize: 18, fontWeight: '900', color: colors.text },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  optional: { color: colors.textMuted, fontWeight: '500' },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  suggestPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  suggestPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  suggestText: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.errorBg,
    padding: 10,
    borderRadius: radius.md,
    marginTop: spacing.md,
  },
  errorText: { color: colors.error, fontSize: 13, flex: 1, fontWeight: '600' },
});
