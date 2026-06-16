// SynCo v2.0 — Pantalla del Especialista.
// - Lee el árbol del proyecto y los nodos hoja autorizados (`scope_node_ids`).
// - Renderiza un cascader dinámico hasta llegar a un nodo hoja autorizado.
// - Formulario: Avance, Contratista, Personal, Equipo + valor de medición.
// - Fotos: Base64 en RAM exclusivamente (Cero Huella Local). Cualquier base64
//   se limpia al limpiar/enviar el formulario.
// - Tras envío exitoso → modal de éxito con botón "Copiar para WhatsApp".
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Modal, Platform,
  Pressable, RefreshControl, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';

import { useAuth } from '@/src/auth-context';
import { Button } from '@/src/components/Button';
import { colors, radius, spacing, shadow } from '@/src/theme';
import { confirm, notify } from '@/src/utils/confirm';
import {
  MEASUREMENT_LABELS, MeasurementType, roleLabel,
} from '@/src/utils/roles';
import { buildWhatsAppMessage, formatMeasurementValue } from '@/src/utils/whatsapp';
import { api, LocationNodeTree, Project } from '@/src/api';

type MeasurementValue = Record<string, any>;

interface CascadeLevel {
  parentName: string | null; // null => raíz
  options: LocationNodeTree[];
  selectedId: string | null;
}

export default function SpecCaptureScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  const projectId = (user?.project_ids || [])[0] || '';
  const allowedLeafIds = useMemo(
    () => new Set<string>(user?.scope_node_ids || []),
    [user?.scope_node_ids],
  );

  // ----- Estado remoto ------------------------------------------------------
  const [project, setProject] = useState<Project | null>(null);
  const [tree, setTree] = useState<LocationNodeTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ----- Cascade (path de nodos seleccionados) ------------------------------
  // `path` contiene todos los nodos ya escogidos en orden, de raíz a hoja.
  const [path, setPath] = useState<LocationNodeTree[]>([]);

  // ----- Form ---------------------------------------------------------------
  const [avance, setAvance] = useState('');
  const [contratista, setContratista] = useState('');
  const [personal, setPersonal] = useState('');
  const [equipo, setEquipo] = useState('');
  const [measurement, setMeasurement] = useState<MeasurementValue>({});
  const [images, setImages] = useState<string[]>([]); // base64 sin prefijo, en RAM
  const [submitting, setSubmitting] = useState(false);

  // ----- Modal de cascada ---------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLevelIdx, setPickerLevelIdx] = useState(0); // qué nivel se está eligiendo

  // ----- Modal de éxito (Modo WhatsApp) ------------------------------------
  const [successOpen, setSuccessOpen] = useState(false);
  const [waMessage, setWaMessage] = useState('');

  // -------------------------------------------------------------------------
  // Carga inicial: proyecto + árbol filtrado a lo autorizado.
  const load = useCallback(async () => {
    if (!projectId) {
      setLoading(false);
      setError('Tu cuenta no está asociada a ningún proyecto. Pide a tu Coordinador General que te envíe una nueva invitación.');
      return;
    }
    try {
      setError(null);
      const [p, t] = await Promise.all([api.getProject(projectId), api.getTree(projectId)]);
      setProject(p);
      setTree(filterTreeByLeafScope(t, allowedLeafIds));
    } catch (e: any) {
      setError(e?.message || 'No se pudo cargar el proyecto');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId, allowedLeafIds]);

  useEffect(() => { load(); }, [load]);

  // -------------------------------------------------------------------------
  // Cascade levels: opciones disponibles en cada paso.
  const levels: CascadeLevel[] = useMemo(() => {
    const out: CascadeLevel[] = [];
    // Nivel 0: raíces del árbol filtrado.
    out.push({
      parentName: null,
      options: tree,
      selectedId: path[0]?.id ?? null,
    });
    // Niveles intermedios.
    for (let i = 0; i < path.length; i++) {
      const node = path[i];
      if (!node.children || node.children.length === 0) break;
      out.push({
        parentName: node.name,
        options: node.children,
        selectedId: path[i + 1]?.id ?? null,
      });
    }
    return out;
  }, [tree, path]);

  const leafNode: LocationNodeTree | null = useMemo(() => {
    const last = path[path.length - 1];
    if (last && last.is_leaf && allowedLeafIds.has(last.id)) return last;
    return null;
  }, [path, allowedLeafIds]);

  const parentOfLeaf: LocationNodeTree | null = useMemo(() => {
    if (!leafNode) return null;
    return path.length >= 2 ? path[path.length - 2] : null;
  }, [path, leafNode]);

  // -------------------------------------------------------------------------
  // Selección en el modal de cascada.
  function openPicker(levelIdx: number) {
    setPickerLevelIdx(levelIdx);
    setPickerOpen(true);
  }

  function pickNode(node: LocationNodeTree) {
    setPickerOpen(false);
    setPath((prev) => {
      const next = prev.slice(0, pickerLevelIdx);
      next.push(node);
      return next;
    });
    // Si el nodo elegido es hoja, reset measurement para que coincida con su tipo.
    if (node.is_leaf) setMeasurement({});
  }

  function resetCascade() {
    setPath([]);
    setMeasurement({});
  }

  // -------------------------------------------------------------------------
  // Cámara + galería (CERO HUELLA: base64 en memoria, no guardamos a disco).
  async function takePhotoFromCamera() {
    try {
      let perm = await ImagePicker.getCameraPermissionsAsync();
      if (perm.status !== 'granted') {
        if (!perm.canAskAgain) {
          await offerOpenSettings('Necesitas permitir el acceso a la cámara en la configuración de tu sistema para tomar fotos.');
          return;
        }
        perm = await ImagePicker.requestCameraPermissionsAsync();
        if (perm.status !== 'granted') return;
      }
      const res = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        base64: true,
        exif: false,
        // Notar: NO llamamos MediaLibrary.saveToLibraryAsync para mantener Cero Huella.
      });
      if (res.canceled || !res.assets?.[0]?.base64) return;
      setImages((prev) => [...prev, res.assets[0].base64!]);
    } catch (e: any) {
      notify('Cámara', e?.message || 'No se pudo abrir la cámara.');
    }
  }

  async function pickPhotoFromLibrary() {
    try {
      let perm = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (perm.status !== 'granted') {
        if (!perm.canAskAgain) {
          await offerOpenSettings('Necesitas permitir el acceso a tu galería de fotos en la configuración para adjuntar imágenes.');
          return;
        }
        perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (perm.status !== 'granted') return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        base64: true,
        exif: false,
        allowsMultipleSelection: Platform.OS !== 'ios', // iOS multi-pick puede pegar
      });
      if (res.canceled) return;
      const newBase64s: string[] = [];
      for (const a of res.assets || []) {
        if (a.base64) newBase64s.push(a.base64);
      }
      if (newBase64s.length) setImages((prev) => [...prev, ...newBase64s]);
    } catch (e: any) {
      notify('Galería', e?.message || 'No se pudo abrir la galería.');
    }
  }

  async function offerOpenSettings(message: string) {
    const ok = await confirm('Permisos requeridos', message, { confirmText: 'Abrir ajustes' });
    if (ok) Linking.openSettings();
  }

  function removeImage(idx: number) {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }

  // -------------------------------------------------------------------------
  // Envío.
  const canSubmit = !!leafNode && !!project && validateMeasurement(leafNode.measurement_type, measurement);

  async function onSubmit() {
    if (!leafNode || !project) return;
    if (!validateMeasurement(leafNode.measurement_type, measurement)) {
      notify('Falta el valor de medición', `Captura el valor requerido (${MEASUREMENT_LABELS[leafNode.measurement_type as MeasurementType] || leafNode.measurement_type}) antes de finalizar.`);
      return;
    }
    setSubmitting(true);
    try {
      const personnelArr = personal.trim() ? [personal.trim()] : [];
      const equipmentArr = equipo.trim() ? [equipo.trim()] : [];
      await api.createReport({
        project_id: project.id,
        node_id: leafNode.id,
        measurement_value: measurement,
        // El backend usa automáticamente user.area_id si no se envía area_id.
        notes: avance.trim() || null,
        avance: avance.trim() || null,
        contratista: contratista.trim() || null,
        personnel: personnelArr,
        equipment: equipmentArr,
        images: images, // base64
      });

      // Construir mensaje WhatsApp dinámico.
      const areaOrPuesto = (user?.puesto || user?.area || '').trim();
      const ubicacion = formatMeasurementValue(leafNode.measurement_type || '', measurement);
      const msg = buildWhatsAppMessage({
        userName: user?.name || '',
        areaOrPuesto,
        contractNumber: project.contract_number,
        parentNodeName: parentOfLeaf?.name || '',
        leafNodeName: leafNode.name,
        ubicacion,
        contratista,
        personal,
        equipo,
      });
      setWaMessage(msg);
      setSuccessOpen(true);
    } catch (e: any) {
      Alert.alert('Error al enviar', e?.message || 'No se pudo registrar el reporte');
    } finally {
      setSubmitting(false);
    }
  }

  function clearFormAndCloseSuccess() {
    // Cero Huella: borrar fotos en RAM al limpiar formulario.
    setAvance('');
    setContratista('');
    setPersonal('');
    setEquipo('');
    setMeasurement({});
    setImages([]);
    resetCascade();
    setSuccessOpen(false);
  }

  async function copyWhatsAppToClipboard() {
    try {
      await Clipboard.setStringAsync(waMessage);
      notify('Copiado', 'Reporte copiado al portapapeles, listo para pegar en WhatsApp.');
    } catch (e: any) {
      notify('Error', e?.message || 'No se pudo copiar');
    }
  }

  async function onLogout() {
    const ok = await confirm('Cerrar sesión', '¿Seguro que deseas salir? Cualquier foto sin enviar se descartará.', { confirmText: 'Salir', destructive: true });
    if (!ok) return;
    setImages([]); // limpia base64 en RAM antes de salir
    await logout();
    router.replace('/(auth)/login');
  }

  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.center, { paddingTop: insets.top, padding: spacing.lg }]}>
        <Ionicons name="alert-circle-outline" size={40} color={colors.error} />
        <Text style={styles.errorTitle}>No se pudo cargar</Text>
        <Text style={styles.errorMsg}>{error}</Text>
        <Button label="Reintentar" onPress={load} fullWidth />
        <View style={{ height: spacing.sm }} />
        <Button label="Cerrar sesión" variant="ghost" onPress={onLogout} fullWidth />
      </View>
    );
  }

  const noAllowedLeaves = allowedLeafIds.size === 0;
  const noTree = !tree.length;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      <StatusBar barStyle="dark-content" />
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.projName} numberOfLines={1}>{project?.name || 'Proyecto'}</Text>
          <Text style={styles.projMeta} numberOfLines={1}>
            {project?.contract_number ? `Contrato ${project.contract_number}` : ''}
            {project?.constructora ? `  ·  ${project.constructora}` : ''}
          </Text>
        </View>
        <Pressable style={styles.iconBtn} onPress={onLogout} hitSlop={8}>
          <Ionicons name="log-out-outline" size={20} color={colors.textBody} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* Tarjeta de usuario */}
        <View style={styles.userCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarTxt}>{initials(user?.name)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.userName}>Ing. {user?.name}</Text>
            <Text style={styles.userRole}>{roleLabel(user?.role, user?.area)}</Text>
            {user?.puesto ? <Text style={styles.userPuesto}>{user.puesto}</Text> : null}
          </View>
        </View>

        {/* Cascada */}
        <SectionCard
          icon="git-branch-outline"
          title="Ubicación"
          subtitle="Selecciona dónde estás capturando."
        >
          {noAllowedLeaves ? (
            <EmptyState
              icon="warning-outline"
              title="Sin nodos asignados"
              msg="Tu invitación no incluye nodos hoja para capturar. Pide a tu Coordinador General que actualice tu scope."
            />
          ) : noTree ? (
            <EmptyState
              icon="git-network-outline"
              title="Aún no hay árbol"
              msg="El Coordinador General todavía no creó nodos visibles para tu scope."
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              {levels.map((lvl, idx) => {
                const selected = lvl.options.find((o) => o.id === lvl.selectedId) || null;
                const label = idx === 0 ? 'Nivel raíz' : (lvl.parentName ? `Dentro de “${lvl.parentName}”` : `Nivel ${idx + 1}`);
                return (
                  <Pressable
                    key={`${idx}-${lvl.parentName || 'root'}`}
                    onPress={() => openPicker(idx)}
                    style={({ pressed }) => [styles.cascadeRow, pressed && { opacity: 0.85 }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cascadeLabel}>{label}</Text>
                      <Text style={[styles.cascadeValue, !selected && { color: colors.textMuted }]} numberOfLines={1}>
                        {selected ? selected.name : 'Seleccionar…'}
                      </Text>
                    </View>
                    {selected?.is_leaf && allowedLeafIds.has(selected.id) ? (
                      <View style={styles.leafBadge}>
                        <Ionicons name="flag" size={11} color={colors.textInverse} />
                        <Text style={styles.leafBadgeTxt}>Hoja</Text>
                      </View>
                    ) : null}
                    <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
                  </Pressable>
                );
              })}
              {path.length > 0 ? (
                <Pressable onPress={resetCascade} hitSlop={8} style={{ alignSelf: 'flex-start', paddingVertical: 6 }}>
                  <Text style={styles.linkBtn}>Reiniciar selección</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </SectionCard>

        {/* Coordenadas objetivo dictadas por el Coordinador (read-only) */}
        {leafNode && leafNode.measurement_type === 'coord_latlon' && (
          (leafNode as any).target_lat != null ||
          (leafNode as any).target_lon != null ||
          (leafNode as any).target_elev != null
        ) ? (
          <SectionCard
            icon="location-outline"
            title="Coordenadas objetivo (oficina)"
            subtitle="Valores dictados por el Coordinador. Solo lectura."
          >
            <View style={styles.coordsTargetGrid}>
              <View style={styles.coordsTargetItem}>
                <Text style={styles.coordsTargetLabel}>Latitud (X)</Text>
                <Text style={styles.coordsTargetValue} numberOfLines={1}>
                  {(leafNode as any).target_lat != null ? String((leafNode as any).target_lat) : '—'}
                </Text>
              </View>
              <View style={styles.coordsTargetItem}>
                <Text style={styles.coordsTargetLabel}>Longitud (Y)</Text>
                <Text style={styles.coordsTargetValue} numberOfLines={1}>
                  {(leafNode as any).target_lon != null ? String((leafNode as any).target_lon) : '—'}
                </Text>
              </View>
              <View style={styles.coordsTargetItem}>
                <Text style={styles.coordsTargetLabel}>Elevación (Z)</Text>
                <Text style={styles.coordsTargetValue} numberOfLines={1}>
                  {(leafNode as any).target_elev != null ? String((leafNode as any).target_elev) : '—'}
                </Text>
              </View>
            </View>
          </SectionCard>
        ) : null}

        {/* Medición */}
        {leafNode ? (
          <SectionCard
            icon="speedometer-outline"
            title={`Medición · ${MEASUREMENT_LABELS[leafNode.measurement_type as MeasurementType] || leafNode.measurement_type}`}
            subtitle="Captura el valor que define la ubicación de este nodo hoja."
          >
            <MeasurementInput
              type={leafNode.measurement_type as MeasurementType}
              value={measurement}
              onChange={setMeasurement}
            />
          </SectionCard>
        ) : null}

        {/* Form principal */}
        {leafNode ? (
          <SectionCard icon="document-text-outline" title="Reporte" subtitle="Avance, personal, equipo y contratista.">
            <Field label="Avance">
              <TextInput
                placeholder="Ej. Colado de zapata Z-4 al 60%"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.inputMulti]}
                multiline
                numberOfLines={3}
                value={avance}
                onChangeText={setAvance}
              />
            </Field>

            <Field label="Contratista">
              <TextInput
                placeholder="Ej. CYPSA"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={contratista}
                onChangeText={setContratista}
              />
            </Field>

            <Field label="Personal">
              <TextInput
                placeholder="Ej. 3 albañiles, 1 cabo"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={personal}
                onChangeText={setPersonal}
              />
            </Field>

            <Field label="Equipo">
              <TextInput
                placeholder="Ej. Retro CAT 320, vibrador 1.5HP"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={equipo}
                onChangeText={setEquipo}
              />
            </Field>
          </SectionCard>
        ) : null}

        {/* Fotos */}
        {leafNode ? (
          <SectionCard
            icon="camera-outline"
            title={`Fotos (${images.length})`}
            subtitle="Cero Huella Local: las imágenes viven solo en RAM hasta enviar."
          >
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              {images.map((b64, i) => (
                <View key={i} style={styles.photoTile}>
                  <Image source={{ uri: `data:image/jpeg;base64,${b64}` }} style={styles.photoImg} />
                  <Pressable onPress={() => removeImage(i)} style={styles.photoRemove} hitSlop={6}>
                    <Ionicons name="close" size={14} color={colors.textInverse} />
                  </Pressable>
                </View>
              ))}
              <Pressable onPress={takePhotoFromCamera} style={[styles.photoTile, styles.photoAdd]}>
                <Ionicons name="camera" size={22} color={colors.primary} />
                <Text style={styles.photoAddTxt}>Cámara</Text>
              </Pressable>
              <Pressable onPress={pickPhotoFromLibrary} style={[styles.photoTile, styles.photoAdd]}>
                <Ionicons name="images-outline" size={22} color={colors.primary} />
                <Text style={styles.photoAddTxt}>Galería</Text>
              </Pressable>
            </View>
          </SectionCard>
        ) : null}

        {/* CTA */}
        {leafNode ? (
          <View style={{ marginTop: spacing.md }}>
            <Button
              label={submitting ? 'Enviando…' : 'Finalizar reporte'}
              onPress={onSubmit}
              loading={submitting}
              disabled={!canSubmit || submitting}
              fullWidth
              icon={<Ionicons name="checkmark-circle" size={18} color="#fff" />}
            />
            {!canSubmit && !submitting ? (
              <Text style={styles.helpHint}>
                Captura el valor de medición requerido para habilitar el envío.
              </Text>
            ) : null}
          </View>
        ) : (
          path.length > 0 && !leafNode ? (
            <Text style={styles.helpHint}>Continúa la selección hasta llegar a un nodo hoja autorizado.</Text>
          ) : null
        )}
      </ScrollView>

      {/* Picker modal */}
      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)} />
        <View style={[styles.modalSheet, { paddingBottom: insets.bottom + spacing.md }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>
            {pickerLevelIdx === 0 ? 'Selecciona nodo raíz' : `Dentro de "${levels[pickerLevelIdx]?.parentName || ''}"`}
          </Text>
          <FlatList
            data={levels[pickerLevelIdx]?.options || []}
            keyExtractor={(n) => n.id}
            renderItem={({ item }) => {
              const isLeaf = item.is_leaf && allowedLeafIds.has(item.id);
              const hasChildren = (item.children?.length || 0) > 0;
              return (
                <Pressable onPress={() => pickNode(item)} style={({ pressed }) => [styles.pickerOption, pressed && { backgroundColor: colors.primaryLight }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerOptionName}>{item.name}</Text>
                    <Text style={styles.pickerOptionMeta}>
                      {isLeaf ? `Hoja · ${MEASUREMENT_LABELS[item.measurement_type as MeasurementType] || item.measurement_type}` : `${item.children?.length || 0} hijo(s)`}
                    </Text>
                  </View>
                  {isLeaf ? (
                    <View style={styles.leafBadge}>
                      <Ionicons name="flag" size={11} color={colors.textInverse} />
                      <Text style={styles.leafBadgeTxt}>Hoja</Text>
                    </View>
                  ) : hasChildren ? (
                    <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
                  ) : null}
                </Pressable>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.sep} />}
            ListEmptyComponent={<Text style={styles.emptyTxt}>Sin opciones disponibles.</Text>}
            style={{ maxHeight: 380 }}
          />
        </View>
      </Modal>

      {/* Modal de éxito (Modo WhatsApp) */}
      <Modal visible={successOpen} animationType="fade" transparent onRequestClose={() => setSuccessOpen(false)}>
        <View style={styles.successBackdrop}>
          <View style={[styles.successCard, { marginTop: insets.top + spacing.xl }]}>
            <View style={styles.successHeader}>
              <View style={styles.successIcon}>
                <Ionicons name="checkmark" size={28} color={colors.textInverse} />
              </View>
              <Text style={styles.successTitle}>Reporte enviado</Text>
              <Text style={styles.successSubtitle}>
                Tus datos y fotos se guardaron en la base. Copia el texto y pégalo en WhatsApp.
              </Text>
            </View>
            <ScrollView style={styles.successPreview} contentContainerStyle={{ padding: spacing.md }}>
              <Text style={styles.successPreviewTxt}>{waMessage}</Text>
            </ScrollView>
            <View style={{ gap: spacing.sm }}>
              <Button
                label="Copiar para WhatsApp"
                onPress={copyWhatsAppToClipboard}
                fullWidth
                icon={<Ionicons name="logo-whatsapp" size={18} color="#fff" />}
              />
              <Button
                label="Nueva captura"
                variant="secondary"
                onPress={clearFormAndCloseSuccess}
                fullWidth
              />
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// ============================================================================
// Componentes auxiliares
// ============================================================================
function SectionCard({ icon, title, subtitle, children }: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionIcon}>
          <Ionicons name={icon} size={16} color={colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>{title}</Text>
          {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      <View>{children}</View>
    </View>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: spacing.sm }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function EmptyState({ icon, title, msg }: { icon: keyof typeof Ionicons.glyphMap; title: string; msg: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: spacing.lg }}>
      <Ionicons name={icon} size={32} color={colors.textMuted} />
      <Text style={[styles.fieldLabel, { marginTop: 8 }]}>{title}</Text>
      <Text style={styles.emptyTxt}>{msg}</Text>
    </View>
  );
}

// ----- Inputs de medición ---------------------------------------------------
function MeasurementInput({ type, value, onChange }: {
  type: MeasurementType;
  value: MeasurementValue;
  onChange: (v: MeasurementValue) => void;
}) {
  if (type === 'coord_latlon') {
    return (
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <Field label="Latitud">
            <TextInput
              keyboardType="numeric"
              placeholder="19.432608"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              value={value.lat != null ? String(value.lat) : ''}
              onChangeText={(t) => onChange({ ...value, lat: parseFloatSafe(t) })}
            />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Longitud">
            <TextInput
              keyboardType="numeric"
              placeholder="-99.133209"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              value={value.lon != null ? String(value.lon) : ''}
              onChangeText={(t) => onChange({ ...value, lon: parseFloatSafe(t) })}
            />
          </Field>
        </View>
      </View>
    );
  }
  if (type === 'cadenamiento') {
    return (
      <Field label="Cadenamiento (formato 5+100 o 5+100.50)">
        <TextInput
          placeholder="5+100"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="none"
          value={value.cadenamiento || ''}
          onChangeText={(t) => onChange({ cadenamiento: t })}
        />
      </Field>
    );
  }
  if (type === 'eje') {
    return (
      <Field label="Eje">
        <TextInput
          placeholder="A, B, 1-2…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          autoCapitalize="characters"
          value={value.eje || ''}
          onChangeText={(t) => onChange({ eje: t })}
        />
      </Field>
    );
  }
  if (type === 'nivel') {
    return (
      <Field label="Nivel (m)">
        <TextInput
          placeholder="12.45"
          placeholderTextColor={colors.textMuted}
          keyboardType="numeric"
          style={styles.input}
          value={value.nivel != null ? String(value.nivel) : ''}
          onChangeText={(t) => onChange({ nivel: parseFloatSafe(t) })}
        />
      </Field>
    );
  }
  return null;
}

// ============================================================================
// Helpers
// ============================================================================
function initials(name?: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('');
}

function parseFloatSafe(t: string): number | string {
  const cleaned = t.replace(',', '.').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return cleaned;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : cleaned;
}

function validateMeasurement(type: string | null | undefined, v: MeasurementValue): boolean {
  if (!type) return false;
  if (type === 'coord_latlon') {
    return typeof v.lat === 'number' && typeof v.lon === 'number'
      && v.lat >= -90 && v.lat <= 90 && v.lon >= -180 && v.lon <= 180;
  }
  if (type === 'cadenamiento') {
    return typeof v.cadenamiento === 'string' && /^\d+\+\d{1,4}(\.\d+)?$/.test(v.cadenamiento);
  }
  if (type === 'eje') {
    return typeof v.eje === 'string' && v.eje.trim().length > 0;
  }
  if (type === 'nivel') {
    return typeof v.nivel === 'number' && Number.isFinite(v.nivel);
  }
  return false;
}

/**
 * Filtra el árbol completo dejando solo las ramas que terminan en una hoja del
 * scope. Si un nodo es hoja pero no está en el scope se omite, y si tras filtrar
 * sus hijos un nodo queda vacío y él mismo no es hoja autorizada, también se omite.
 */
function filterTreeByLeafScope(
  tree: LocationNodeTree[],
  allowed: Set<string>,
): LocationNodeTree[] {
  if (allowed.size === 0) return [];
  const recur = (nodes: LocationNodeTree[]): LocationNodeTree[] => {
    const out: LocationNodeTree[] = [];
    for (const n of nodes || []) {
      const filteredChildren = recur(n.children || []);
      const isAllowedLeaf = n.is_leaf && allowed.has(n.id);
      if (isAllowedLeaf || filteredChildren.length > 0) {
        out.push({ ...n, children: filteredChildren });
      }
    }
    return out;
  };
  return recur(tree);
}

// ============================================================================
// Styles
// ============================================================================
const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg, gap: spacing.sm },
  errorTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginTop: spacing.sm },
  errorMsg: { textAlign: 'center', color: colors.textBody, marginBottom: spacing.md },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  projName: { fontSize: 16, fontWeight: '800', color: colors.text },
  projMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  iconBtn: { padding: 8, borderRadius: radius.full, backgroundColor: colors.bg },

  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  avatar: {
    width: 44, height: 44, borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarTxt: { color: colors.textInverse, fontWeight: '800', fontSize: 15 },
  userName: { fontSize: 15, fontWeight: '800', color: colors.text },
  userRole: { fontSize: 12, color: colors.primary, fontWeight: '700', marginTop: 2 },
  userPuesto: { fontSize: 12, color: colors.textMuted, marginTop: 2 },

  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadow.card,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  sectionIcon: {
    width: 28, height: 28, borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center',
  },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
  sectionSubtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2 },

  cascadeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 56,
  },
  cascadeLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  cascadeValue: { fontSize: 15, color: colors.text, fontWeight: '700', marginTop: 2 },

  leafBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: radius.full,
  },
  leafBadgeTxt: { color: colors.textInverse, fontSize: 10, fontWeight: '800' },

  linkBtn: { color: colors.primary, fontWeight: '700', fontSize: 13 },

  fieldLabel: { fontSize: 12, color: colors.textBody, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.3 },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 15,
    color: colors.text,
    minHeight: 44,
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },

  photoTile: {
    width: 88, height: 88, borderRadius: radius.md, overflow: 'hidden',
    borderWidth: 1, borderColor: colors.border,
  },
  photoImg: { width: '100%', height: '100%' },
  photoRemove: {
    position: 'absolute', top: 4, right: 4,
    width: 22, height: 22, borderRadius: radius.full,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  photoAdd: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primaryLight,
    borderColor: colors.primary, borderStyle: 'dashed',
    gap: 4,
  },
  photoAddTxt: { color: colors.primary, fontSize: 11, fontWeight: '700' },

  helpHint: { marginTop: spacing.sm, color: colors.textMuted, fontSize: 12, textAlign: 'center' },

  // Picker modal
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay },
  modalSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: spacing.md, paddingTop: spacing.sm,
  },
  sheetHandle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, marginBottom: spacing.sm,
  },
  sheetTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  pickerOption: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 12, paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  pickerOptionName: { fontSize: 14, fontWeight: '700', color: colors.text },
  pickerOptionMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  sep: { height: 1, backgroundColor: colors.border, marginLeft: spacing.sm },
  emptyTxt: { textAlign: 'center', color: colors.textMuted, padding: spacing.md, fontSize: 12 },

  // Success
  successBackdrop: { flex: 1, backgroundColor: colors.overlay, padding: spacing.md, justifyContent: 'flex-start' },
  successCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.md,
  },
  successHeader: { alignItems: 'center', gap: 6 },
  successIcon: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: colors.success,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  successTitle: { fontSize: 18, fontWeight: '800', color: colors.text },
  successSubtitle: { fontSize: 12, color: colors.textBody, textAlign: 'center' },
  successPreview: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    maxHeight: 280,
  },
  successPreviewTxt: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 12, color: colors.text, lineHeight: 18 },
  // Coordenadas objetivo (read-only para el especialista)
  coordsTargetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  coordsTargetItem: {
    flex: 1, minWidth: '30%',
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md, padding: 10, gap: 4,
    borderWidth: 1, borderColor: colors.primary,
  },
  coordsTargetLabel: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.6 },
  coordsTargetValue: { fontSize: 14, fontWeight: '800', color: colors.text },
});
