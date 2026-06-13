import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView, Pressable, Alert,
  ActivityIndicator, Platform, KeyboardAvoidingView, RefreshControl, Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { ReadOnlyGuard } from '@/src/components/ReadOnlyGuard';
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

function AreaSelector({
  areas, value, onChange,
}: { areas: Area[]; value: string | null; onChange: (v: string | null) => void }) {
  return (
    <View style={styles.chipsRow}>
      <Pressable
        onPress={() => onChange(null)}
        style={[styles.chip, value === null && { backgroundColor: colors.primary, borderColor: colors.primary }]}
      >
        <Ionicons name="globe-outline" size={14}
          color={value === null ? colors.textInverse : colors.textBody} />
        <Text style={[styles.chipLabel, value === null && { color: colors.textInverse }]}>Global</Text>
      </Pressable>
      {areas.map((a) => {
        const selected = value === a.id;
        const tone = areaTone(a.color);
        return (
          <Pressable
            key={a.id}
            onPress={() => onChange(a.id)}
            style={[
              styles.chip,
              { borderColor: tone.border, backgroundColor: tone.bg },
              selected && { backgroundColor: a.color, borderColor: a.color },
            ]}
          >
            <View style={[styles.chipDot, { backgroundColor: selected ? colors.textInverse : a.color }]} />
            <Text style={[styles.chipLabel, { color: selected ? colors.textInverse : tone.text }]}>{a.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function PuntosSettings() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [areas, setAreas] = useState<Area[]>([]);
  const [points, setPoints] = useState<ReferencePoint[]>([]);

  // Form crear
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [coords, setCoords] = useState('');
  const [areaId, setAreaId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Modal editar
  const [editing, setEditing] = useState<ReferencePoint | null>(null);
  const [eName, setEName] = useState('');
  const [eLocation, setELocation] = useState('');
  const [eCoords, setECoords] = useState('');
  const [eAreaId, setEAreaId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ars, pts] = await Promise.all([
        api.listAreas(),
        api.listReferencePoints(),
      ]);
      setAreas(ars || []);
      setPoints(pts || []);
    } catch (e: any) {
      Alert.alert('Error al cargar', e?.message || 'Error');
    } finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function onAdd() {
    const n = name.trim();
    if (!n) { Alert.alert('Falta nombre', 'Ingresa un nombre para el punto.'); return; }
    setAdding(true);
    try {
      await api.createReferencePoint({
        name: n,
        location: location.trim() || null,
        coordinates: coords.trim() || null,
        area: areaId,
      });
      setName(''); setLocation(''); setCoords(''); setAreaId(null);
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo agregar', e?.message || 'Error');
    } finally { setAdding(false); }
  }

  function openEdit(p: ReferencePoint) {
    setEditing(p);
    setEName(p.name);
    setELocation(p.location || '');
    setECoords(p.coordinates || '');
    setEAreaId(p.area || null);
  }

  async function saveEdit() {
    if (!editing) return;
    const n = eName.trim();
    if (!n) { Alert.alert('Falta nombre', 'Ingresa un nombre para el punto.'); return; }
    setSaving(true);
    try {
      await api.updateReferencePoint(editing.id, {
        name: n,
        location: eLocation.trim() || null,
        coordinates: eCoords.trim() || null,
        area: eAreaId,
      });
      setEditing(null);
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Error');
    } finally { setSaving(false); }
  }

  function confirmDelete(p: ReferencePoint) {
    Alert.alert('Eliminar punto',
      `¿Eliminar "${p.name}"? Esto no afectará reportes existentes.`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Eliminar', style: 'destructive',
          onPress: async () => {
            try { await api.deleteReferencePoint(p.id); await load(); }
            catch (e: any) { Alert.alert('No se pudo eliminar', e?.message || 'Error'); }
          },
        },
      ]);
  }

  if (loading) {
    return (
      <ReadOnlyGuard title="Puntos de referencia">
      <View style={styles.flex}>
        <AppHeader title="Puntos de referencia" back />
        <View style={styles.centerFull}><ActivityIndicator color={colors.primary} size="large" /></View>
      </View>
      </ReadOnlyGuard>
    );
  }

  return (
    <ReadOnlyGuard title="Puntos de referencia">
    <View style={styles.flex}>
      <AppHeader title="Puntos de referencia" subtitle={`${points.length} registrados`} back />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 32 }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary}
            onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          {/* CREAR */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
              <Text style={styles.cardTitle}>Nuevo punto</Text>
            </View>

            <Text style={styles.label}>Nombre</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="flag-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={name} onChangeText={setName}
                placeholder="Ej. Poste K0+250"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Ubicación</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="map-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={location} onChangeText={setLocation}
                placeholder="Ej. Tramo 3 – Margen derecho"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Coordenadas</Text>
            <View style={styles.inputWrap}>
              <Ionicons name="navigate-outline" size={18} color={colors.textMuted} />
              <TextInput
                value={coords} onChangeText={setCoords}
                placeholder="Ej. 19.4326, -99.1332"
                placeholderTextColor={colors.textMuted}
                style={styles.input} autoCapitalize="none"
              />
            </View>

            <Text style={[styles.label, { marginTop: spacing.md }]}>Disponible para</Text>
            <AreaSelector areas={areas} value={areaId} onChange={setAreaId} />

            <View style={{ height: spacing.md }} />
            <Button
              label="Agregar punto"
              onPress={onAdd}
              loading={adding}
              icon={<Ionicons name="add-circle-outline" size={18} color={colors.textInverse} />}
              fullWidth
            />
          </View>

          {/* LISTA */}
          <Text style={styles.section}>Registrados ({points.length})</Text>
          {points.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="location-outline" size={28} color={colors.textMuted} />
              <Text style={styles.emptyText}>Aún no hay puntos.</Text>
              <Text style={styles.emptySub}>Crea el primero arriba para habilitar el autocompletado.</Text>
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
                      <View style={[
                        styles.tag,
                        isGlobal
                          ? { backgroundColor: colors.primaryLight, borderColor: colors.primary + '55' }
                          : { backgroundColor: tone.bg, borderColor: tone.border },
                      ]}>
                        <Text style={[styles.tagText,
                          { color: isGlobal ? colors.primary : tone.text }]}>
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
                  <Pressable onPress={() => openEdit(p)} hitSlop={8} style={styles.editBtn}>
                    <Ionicons name="create-outline" size={18} color={colors.primary} />
                  </Pressable>
                  <Pressable onPress={() => confirmDelete(p)} hitSlop={8} style={styles.delBtn}>
                    <Ionicons name="trash-outline" size={18} color={colors.error} />
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* MODAL EDITAR */}
      <Modal
        visible={!!editing} transparent animationType="slide"
        onRequestClose={() => setEditing(null)}
      >
        <View style={styles.modalBackdrop}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={{ flex: 1, justifyContent: 'flex-end' }}
          >
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.handle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Editar punto</Text>
                <Pressable onPress={() => setEditing(null)} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textBody} />
                </Pressable>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md }}>
                <View>
                  <Text style={styles.label}>Nombre</Text>
                  <View style={styles.inputWrap}>
                    <Ionicons name="flag-outline" size={18} color={colors.textMuted} />
                    <TextInput value={eName} onChangeText={setEName} style={styles.input}
                      placeholderTextColor={colors.textMuted} />
                  </View>
                </View>
                <View>
                  <Text style={styles.label}>Ubicación</Text>
                  <View style={styles.inputWrap}>
                    <Ionicons name="map-outline" size={18} color={colors.textMuted} />
                    <TextInput value={eLocation} onChangeText={setELocation} style={styles.input}
                      placeholderTextColor={colors.textMuted} />
                  </View>
                </View>
                <View>
                  <Text style={styles.label}>Coordenadas</Text>
                  <View style={styles.inputWrap}>
                    <Ionicons name="navigate-outline" size={18} color={colors.textMuted} />
                    <TextInput value={eCoords} onChangeText={setECoords} style={styles.input}
                      autoCapitalize="none" placeholderTextColor={colors.textMuted} />
                  </View>
                </View>
                <View>
                  <Text style={styles.label}>Disponible para</Text>
                  <AreaSelector areas={areas} value={eAreaId} onChange={setEAreaId} />
                </View>
                <Button label="Guardar cambios" onPress={saveEdit} loading={saving} fullWidth />
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
    </ReadOnlyGuard>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  centerFull: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.sm },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingHorizontal: 12, backgroundColor: colors.surface,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface,
  },
  chipLabel: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  section: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.sm, paddingHorizontal: 4 },
  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.xl, gap: 6 },
  emptyText: { color: colors.textBody, fontSize: 14, fontWeight: '700' },
  emptySub: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingHorizontal: spacing.lg },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, padding: spacing.md,
  },
  rowIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  rowSub: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  rowCoords: { fontSize: 11, color: colors.textMuted, marginTop: 3 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full, borderWidth: 1 },
  tagText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  editBtn: { padding: 6 },
  delBtn: { padding: 6 },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: spacing.md, maxHeight: '92%',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: spacing.sm },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  modalTitle: { fontSize: 18, fontWeight: '900', color: colors.text },
});
