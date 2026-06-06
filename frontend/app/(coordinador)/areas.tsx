import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

interface Area { id: string; name: string; color: string; icon?: string }

const COLOR_PALETTE = [
  '#1E40AF', '#2563EB', '#0EA5E9', '#059669', '#D97706',
  '#DC2626', '#7C3AED', '#DB2777', '#0F172A', '#475569',
];

export default function AreasScreen() {
  const insets = useSafeAreaInsets();
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLOR_PALETTE[0]);

  const load = useCallback(async () => {
    try {
      const data = await api.listAreas();
      setAreas(data);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function onAdd() {
    if (!name.trim()) return;
    setAdding(true);
    try {
      await api.createArea(name.trim(), color);
      setName('');
      setColor(COLOR_PALETTE[0]);
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo agregar', e?.message || 'Error');
    } finally {
      setAdding(false);
    }
  }

  function confirmDelete(a: Area) {
    Alert.alert(
      'Eliminar área',
      `¿Eliminar "${a.name}"? No se puede deshacer.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteArea(a.id);
              await load();
            } catch (e: any) {
              Alert.alert('No se pudo eliminar', e?.message || 'Error');
            }
          },
        },
      ],
    );
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Áreas de trabajo" subtitle="Agrega o elimina áreas" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Nueva área</Text>
            <Text style={styles.label}>Nombre</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="hammer-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="Ej. Estructuras, Pavimentos…"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>
            <Text style={[styles.label, { marginTop: spacing.md }]}>Color</Text>
            <View style={styles.palette}>
              {COLOR_PALETTE.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setColor(c)}
                  style={[
                    styles.swatch,
                    { backgroundColor: c, borderWidth: color === c ? 3 : 1, borderColor: color === c ? colors.text : colors.border },
                  ]}
                />
              ))}
            </View>
            <View style={{ height: spacing.md }} />
            <Button label="Agregar área" onPress={onAdd} loading={adding} fullWidth />
          </View>

          <Text style={styles.section}>Áreas existentes</Text>
          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
          ) : areas.length === 0 ? (
            <Text style={styles.empty}>Sin áreas registradas.</Text>
          ) : (
            areas.map((a) => (
              <View key={a.id} style={styles.row}>
                <View style={[styles.rowDot, { backgroundColor: a.color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{a.name}</Text>
                  <Text style={styles.rowSub}>{a.id}</Text>
                </View>
                <Pressable onPress={() => confirmDelete(a)} hitSlop={8} style={styles.delBtn}>
                  <Ionicons name="trash-outline" size={18} color={colors.error} />
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text },
  palette: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { width: 36, height: 36, borderRadius: 18 },
  section: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.md },
  empty: { color: colors.textMuted, fontSize: 13, marginTop: spacing.md, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  rowDot: { width: 14, height: 14, borderRadius: 7 },
  rowTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  rowSub: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  delBtn: { padding: 6 },
});
