import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { colors, radius, spacing, areaTone } from '@/src/theme';

interface Area { id: string; name: string; color: string; icon?: string }
interface ReferencePoint {
  id: string;
  name: string;
  location?: string | null;
  coordinates?: string | null;
  area?: string | null;
  areaName?: string | null;
  createdByName: string;
  createdAt: string;
}

export default function CoordSettingsScreen() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Site config
  const [contract, setContract] = useState('');
  const [contractor, setContractor] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedBy, setSavedBy] = useState<string | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);

  // Reference points + areas
  const [areas, setAreas] = useState<Area[]>([]);
  const [points, setPoints] = useState<ReferencePoint[]>([]);

  // New reference point form
  const [rpName, setRpName] = useState('');
  const [rpLocation, setRpLocation] = useState('');
  const [rpCoords, setRpCoords] = useState('');
  // null = Global
  const [rpAreaId, setRpAreaId] = useState<string | null>(null);
  const [addingRp, setAddingRp] = useState(false);

  const load = useCallback(async () => {
    try {
      const [cfg, ars, pts] = await Promise.all([
        api.getSiteConfig(),
        api.listAreas(),
        api.listReferencePoints(),
      ]);
      setContract(cfg.contract || '');
      setContractor(cfg.contractor || '');
      setSavedAt(cfg.updatedAt || null);
      setSavedBy(cfg.updatedBy || null);
      setAreas(ars || []);
      setPoints(pts || []);
    } catch (e: any) {
      Alert.alert('Error al cargar', e?.message || 'Error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function onRefresh() {
    setRefreshing(true);
    load();
  }

  async function onSaveConfig() {
    setSavingCfg(true);
    try {
      const updated = await api.updateSiteConfig({
        contract: contract.trim(),
        contractor: contractor.trim(),
      });
      setContract(updated.contract || '');
      setContractor(updated.contractor || '');
      setSavedAt(updated.updatedAt || null);
      setSavedBy(updated.updatedBy || null);
      Alert.alert('Guardado', 'Configuración del proyecto actualizada.');
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Error');
    } finally {
      setSavingCfg(false);
    }
  }

  async function onAddPoint() {
    const name = rpName.trim();
    if (!name) {
      Alert.alert('Falta nombre', 'Ingresa un nombre para el punto de referencia.');
      return;
    }
    setAddingRp(true);
    try {
      await api.createReferencePoint({
        name,
        location: rpLocation.trim() || null,
        coordinates: rpCoords.trim() || null,
        area: rpAreaId, // null = global
      });
      setRpName('');
      setRpLocation('');
      setRpCoords('');
      setRpAreaId(null);
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo agregar', e?.message || 'Error');
    } finally {
      setAddingRp(false);
    }
  }

  function confirmDeletePoint(p: ReferencePoint) {
    Alert.alert(
      'Eliminar punto',
      `¿Eliminar "${p.name}"? Esto no afectará a reportes existentes.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteReferencePoint(p.id);
              await load();
            } catch (e: any) {
              Alert.alert('No se pudo eliminar', e?.message || 'Error');
            }
          },
        },
      ],
    );
  }

  const lastUpdate = useMemo(() => {
    if (!savedAt) return null;
    try {
      const d = new Date(savedAt);
      return d.toLocaleString();
    } catch {
      return savedAt;
    }
  }, [savedAt]);

  if (loading) {
    return (
      <View style={styles.flex}>
        <AppHeader title="Menú del Coordinador" subtitle="Configuración del proyecto" />
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Menú del Coordinador" subtitle="Configuración del proyecto" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* --- SITE CONFIG --- */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="document-text-outline" size={20} color={colors.primary} />
              <Text style={styles.cardTitle}>Variables Globales</Text>
            </View>
            <Text style={styles.cardHint}>
              Se aplican a todos los reportes del proyecto y se rellenan automáticamente en los encabezados.
            </Text>

            <Text style={styles.label}>Número de contrato</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="pricetag-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={contract}
                onChangeText={setContract}
                placeholder="Ej. CT-2025-0142"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                autoCapitalize="characters"
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Contratista</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="business-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={contractor}
                onChangeText={setContractor}
                placeholder="Ej. Constructora ACME S.A."
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>

            {lastUpdate ? (
              <Text style={styles.meta}>
                Última actualización: {lastUpdate}
                {savedBy ? ` · por ${savedBy}` : ''}
              </Text>
            ) : null}

            <View style={{ height: spacing.md }} />
            <Button
              label="Guardar configuración"
              onPress={onSaveConfig}
              loading={savingCfg}
              icon={<Ionicons name="save-outline" size={18} color={colors.textInverse} />}
              fullWidth
            />
          </View>

          {/* --- REFERENCE POINTS --- */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="location-outline" size={20} color={colors.primary} />
              <Text style={styles.cardTitle}>Puntos de Referencia</Text>
            </View>
            <Text style={styles.cardHint}>
              Define postes / hitos para autocompletar Ubicación y Coordenadas en los reportes inteligentes.
            </Text>

            <Text style={styles.label}>Nombre</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="flag-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={rpName}
                onChangeText={setRpName}
                placeholder="Ej. Poste K0+250"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Ubicación (descripción)</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="map-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={rpLocation}
                onChangeText={setRpLocation}
                placeholder="Ej. Tramo 3 – Margen derecho"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Coordenadas</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="navigate-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={rpCoords}
                onChangeText={setRpCoords}
                placeholder="Ej. 19.4326, -99.1332"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                autoCapitalize="none"
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Disponible para</Text>
            <View style={styles.chipsRow}>
              <Pressable
                onPress={() => setRpAreaId(null)}
                style={[
                  styles.chip,
                  rpAreaId === null && { backgroundColor: colors.primary, borderColor: colors.primary },
                ]}
              >
                <Ionicons
                  name="globe-outline"
                  size={14}
                  color={rpAreaId === null ? colors.textInverse : colors.textBody}
                />
                <Text
                  style={[
                    styles.chipLabel,
                    rpAreaId === null && { color: colors.textInverse },
                  ]}
                >
                  Global (todas las áreas)
                </Text>
              </Pressable>

              {areas.map((a) => {
                const selected = rpAreaId === a.id;
                const tone = areaTone(a.color);
                return (
                  <Pressable
                    key={a.id}
                    onPress={() => setRpAreaId(a.id)}
                    style={[
                      styles.chip,
                      { borderColor: tone.border, backgroundColor: tone.bg },
                      selected && { backgroundColor: a.color, borderColor: a.color },
                    ]}
                  >
                    <View
                      style={[
                        styles.chipDot,
                        { backgroundColor: selected ? colors.textInverse : a.color },
                      ]}
                    />
                    <Text
                      style={[
                        styles.chipLabel,
                        { color: selected ? colors.textInverse : tone.text },
                      ]}
                    >
                      {a.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={{ height: spacing.md }} />
            <Button
              label="+ Nuevo punto de referencia"
              onPress={onAddPoint}
              loading={addingRp}
              icon={<Ionicons name="add-circle-outline" size={18} color={colors.textInverse} />}
              fullWidth
            />
          </View>

          {/* --- POINTS LIST --- */}
          <Text style={styles.section}>Puntos registrados ({points.length})</Text>
          {points.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="location-outline" size={28} color={colors.textMuted} />
              <Text style={styles.emptyText}>Aún no hay puntos de referencia.</Text>
              <Text style={styles.emptySub}>Crea el primero arriba para habilitar el autocompletado en los reportes.</Text>
            </View>
          ) : (
            points.map((p) => {
              const isGlobal = !p.area;
              const areaObj = areas.find((a) => a.id === p.area);
              const tone = areaTone(areaObj?.color);
              return (
                <View key={p.id} style={styles.row}>
                  <View style={[styles.rowIcon, { backgroundColor: isGlobal ? colors.primaryLight : tone.bg }]}>
                    <Ionicons
                      name={isGlobal ? 'globe-outline' : 'location'}
                      size={18}
                      color={isGlobal ? colors.primary : tone.text}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{p.name}</Text>
                    <View style={styles.rowMetaRow}>
                      <View
                        style={[
                          styles.tag,
                          isGlobal
                            ? { backgroundColor: colors.primaryLight, borderColor: colors.primary + '55' }
                            : { backgroundColor: tone.bg, borderColor: tone.border },
                        ]}
                      >
                        <Text
                          style={[
                            styles.tagText,
                            { color: isGlobal ? colors.primary : tone.text },
                          ]}
                        >
                          {isGlobal ? 'Global' : (areaObj?.name || p.areaName || 'Área')}
                        </Text>
                      </View>
                      {p.location ? (
                        <Text style={styles.rowSub} numberOfLines={1}>· {p.location}</Text>
                      ) : null}
                    </View>
                    {p.coordinates ? (
                      <Text style={styles.rowCoords} numberOfLines={1}>
                        <Ionicons name="navigate" size={11} color={colors.textMuted} /> {p.coordinates}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable
                    onPress={() => confirmDeletePoint(p)}
                    hitSlop={8}
                    style={styles.delBtn}
                  >
                    <Ionicons name="trash-outline" size={18} color={colors.error} />
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  cardHint: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.md, lineHeight: 16 },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
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
  meta: { marginTop: spacing.sm, fontSize: 11, color: colors.textMuted, fontStyle: 'italic' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  chipLabel: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  section: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.sm, paddingHorizontal: 4 },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    gap: 6,
  },
  emptyText: { color: colors.textBody, fontSize: 14, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingHorizontal: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rowSub: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  rowCoords: { fontSize: 11, color: colors.textMuted, marginTop: 3 },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  tagText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  delBtn: { padding: 6 },
});
