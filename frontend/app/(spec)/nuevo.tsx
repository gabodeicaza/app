// SynCo v2.0 — Pantalla del Especialista (Captura Rápida v2).
// - Auto-data read-only (fecha, nombre, rol, contrato, ubicación).
// - Lecturas P/U con helper histórico "Última lectura registrada en este nodo".
// - Actividades + Observaciones (multilínea).
// - Personal y Equipo como listas dinámicas con [-] [+] y autocomplete vía
//   AsyncStorage (catálogo local de items previamente capturados).
// - Fotos: Base64 en RAM (Cero Huella Local).
// - Tras éxito → modal "Modo WhatsApp" con botones Copiar y Enviar.
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
import { storage } from '@/src/utils/storage';
import {
  MEASUREMENT_LABELS, MeasurementType, roleLabel,
} from '@/src/utils/roles';
import {
  buildWhatsAppMessage, formatMeasurementValue, formatDateLongES,
  fmtNum2, Unidad,
} from '@/src/utils/whatsapp';
import { api, LocationNodeTree, Project } from '@/src/api';

const UNIDAD_OPTIONS: Unidad[] = ['km', 'm', 'cm'];

type MeasurementValue = Record<string, any>;

interface CascadeLevel {
  parentName: string | null;
  options: LocationNodeTree[];
  selectedId: string | null;
}

interface DynItem {
  id: string;
  qty: number;
  desc: string;
}

interface NodeHistorySnapshot {
  has_previous: boolean;
  ultima_lectura: number | null;
  primera_lectura: number | null;
  captured_by_name: string | null;
  created_at: string | null;
}

const CATALOG_PERSONAL_KEY = 'syncsite_catalog_personal';
const CATALOG_EQUIPO_KEY = 'syncsite_catalog_equipo';
const MAX_CATALOG_SIZE = 80;

export default function SpecCaptureScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();

  const projectId = (user?.project_ids || [])[0] || '';
  // Para especialistas: scope_node_ids (lista de hojas asignadas).
  // Para sub-coordinadores: scope_node_id (un nodo padre) → todas las hojas descendientes son válidas.
  const isSubCoord = user?.role === 'sub_coordinador';

  // ----- Estado remoto (declarado ANTES de los useMemo que lo referencian) --
  const [project, setProject] = useState<Project | null>(null);
  const [tree, setTree] = useState<LocationNodeTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allowedLeafIds = useMemo(() => {
    if (isSubCoord) {
      // Marcamos como "permitido" cualquier nodo hoja presente en el árbol
      // (el backend ya filtra el árbol al scope del sub-coord).
      const set = new Set<string>();
      const walk = (nodes: any[]) => {
        for (const n of nodes || []) {
          if (n?.is_leaf) set.add(n.id);
          if (n?.children?.length) walk(n.children);
        }
      };
      walk(tree as any[]);
      return set;
    }
    return new Set<string>(user?.scope_node_ids || []);
  }, [isSubCoord, user?.scope_node_ids, tree]);

  // ----- Cascade -----------------------------------------------------------
  const [path, setPath] = useState<LocationNodeTree[]>([]);

  // ----- Form --------------------------------------------------------------
  const [actividades, setActividades] = useState('');
  const [observaciones, setObservaciones] = useState('');
  const [primeraLectura, setPrimeraLectura] = useState('');
  const [ultimaLectura, setUltimaLectura] = useState('');
  const [unidad, setUnidad] = useState<Unidad>('m');
  const [personal, setPersonal] = useState<DynItem[]>([]);
  const [equipo, setEquipo] = useState<DynItem[]>([]);
  const [measurement, setMeasurement] = useState<MeasurementValue>({});
  const [images, setImages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // ----- Catálogos AsyncStorage --------------------------------------------
  const [catalogPersonal, setCatalogPersonal] = useState<string[]>([]);
  const [catalogEquipo, setCatalogEquipo] = useState<string[]>([]);

  // ----- Historial nodo ----------------------------------------------------
  const [nodeHistory, setNodeHistory] = useState<NodeHistorySnapshot | null>(null);
  const [nodeHistoryLoading, setNodeHistoryLoading] = useState(false);

  // Contratista / Contrato: captura libre simple (TextInputs).
  const [contratistaText, setContratistaText] = useState<string>('');
  const [contratoText, setContratoText] = useState<string>('');

  // Sincronizar defaults cuando llega el proyecto.
  useEffect(() => {
    if (!project) return;
    if (!contratistaText && project.constructora) {
      setContratistaText(project.constructora);
    }
    if (!contratoText && project.contract_number) {
      setContratoText(project.contract_number);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Valor efectivo (lo que va al reporte / WhatsApp)
  const contratistaEfectivo = contratistaText.trim();
  const contratoEfectivo = contratoText.trim();

  // ----- Modal cascada -----------------------------------------------------
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLevelIdx, setPickerLevelIdx] = useState(0);

  // ----- Modal éxito (WhatsApp) --------------------------------------------
  const [successOpen, setSuccessOpen] = useState(false);
  const [waMessage, setWaMessage] = useState('');

  // -------------------------------------------------------------------------
  // Carga inicial.
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
      // Sub-coordinador: scope GLOBAL (sin filtrado de hojas).
      setTree(isSubCoord ? t : filterTreeByLeafScope(t, allowedLeafIds));
    } catch (e: any) {
      setError(e?.message || 'No se pudo cargar el proyecto');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId, allowedLeafIds]);

  useEffect(() => { load(); }, [load]);

  // Cargar catálogos de AsyncStorage al iniciar.
  useEffect(() => {
    (async () => {
      const p = await storage.getItem<string>(CATALOG_PERSONAL_KEY, '[]');
      const e = await storage.getItem<string>(CATALOG_EQUIPO_KEY, '[]');
      try { setCatalogPersonal(JSON.parse(p || '[]') as string[]); } catch { setCatalogPersonal([]); }
      try { setCatalogEquipo(JSON.parse(e || '[]') as string[]); } catch { setCatalogEquipo([]); }
    })();
  }, []);

  // -------------------------------------------------------------------------
  // Cascade levels.
  const levels: CascadeLevel[] = useMemo(() => {
    const out: CascadeLevel[] = [];
    out.push({ parentName: null, options: tree, selectedId: path[0]?.id ?? null });
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

  // Ubicación legible (path completo).
  const ubicacionPathLabel = useMemo(() => {
    if (path.length === 0) return 'Sin seleccionar';
    return path.map((n) => n.name).join(' / ');
  }, [path]);

  // -------------------------------------------------------------------------
  // Pre-cargar Lat/Lon desde target_lat/target_lon del nodo cuando aplique.
  // Estos campos son SOLO LECTURA para el Especialista: los precarga el Coordinador.
  useEffect(() => {
    if (!leafNode) return;
    if (leafNode.measurement_type !== 'coord_latlon') return;
    const tLat = (leafNode as any).target_lat;
    const tLon = (leafNode as any).target_lon;
    setMeasurement((prev) => ({
      ...prev,
      lat: typeof tLat === 'number' ? tLat : prev.lat,
      lon: typeof tLon === 'number' ? tLon : prev.lon,
    }));
  }, [leafNode]);

  // -------------------------------------------------------------------------
  // Cargar historial del nodo cuando se selecciona una hoja.
  useEffect(() => {
    if (!leafNode || !projectId) {
      setNodeHistory(null);
      return;
    }
    let cancelled = false;
    setNodeHistoryLoading(true);
    (async () => {
      try {
        const h = await api.nodeHistory(projectId, leafNode.id);
        if (cancelled) return;
        if (h.has_previous && h.last_report) {
          setNodeHistory({
            has_previous: true,
            ultima_lectura: h.last_report.ultima_lectura ?? null,
            primera_lectura: h.last_report.primera_lectura ?? null,
            captured_by_name: h.last_report.captured_by_name || null,
            created_at: h.last_report.created_at || null,
          });
        } else {
          setNodeHistory({
            has_previous: false,
            ultima_lectura: null,
            primera_lectura: null,
            captured_by_name: null,
            created_at: null,
          });
        }
      } catch {
        if (!cancelled) setNodeHistory(null);
      } finally {
        if (!cancelled) setNodeHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [leafNode, projectId]);

  // -------------------------------------------------------------------------
  // Picker.
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
    if (node.is_leaf) setMeasurement({});
  }
  function resetCascade() {
    setPath([]);
    setMeasurement({});
    setNodeHistory(null);
  }

  // -------------------------------------------------------------------------
  // Cámara/galería (RAM only).
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
        allowsMultipleSelection: Platform.OS !== 'ios',
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
  // Catálogo AsyncStorage.
  async function persistCatalog(key: string, list: string[]) {
    // Dedupe + cap.
    const seen = new Set<string>();
    const trimmed: string[] = [];
    for (const s of list) {
      const k = s.trim();
      if (!k) continue;
      const norm = k.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      trimmed.push(k);
      if (trimmed.length >= MAX_CATALOG_SIZE) break;
    }
    await storage.setItem(key, JSON.stringify(trimmed));
  }

  async function addToCatalog(kind: 'personal' | 'equipo', descs: string[]) {
    const cleaned = descs.map((s) => s.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    if (kind === 'personal') {
      const merged = [...cleaned, ...catalogPersonal];
      const out: string[] = [];
      const seen = new Set<string>();
      for (const s of merged) {
        const n = s.toLowerCase();
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(s);
        if (out.length >= MAX_CATALOG_SIZE) break;
      }
      setCatalogPersonal(out);
      await persistCatalog(CATALOG_PERSONAL_KEY, out);
    } else {
      const merged = [...cleaned, ...catalogEquipo];
      const out: string[] = [];
      const seen = new Set<string>();
      for (const s of merged) {
        const n = s.toLowerCase();
        if (seen.has(n)) continue;
        seen.add(n);
        out.push(s);
        if (out.length >= MAX_CATALOG_SIZE) break;
      }
      setCatalogEquipo(out);
      await persistCatalog(CATALOG_EQUIPO_KEY, out);
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic items helpers.
  function addItem(kind: 'personal' | 'equipo') {
    const newItem: DynItem = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, qty: 1, desc: '' };
    if (kind === 'personal') setPersonal((prev) => [...prev, newItem]);
    else setEquipo((prev) => [...prev, newItem]);
  }
  function updateItem(kind: 'personal' | 'equipo', id: string, patch: Partial<DynItem>) {
    const updater = (prev: DynItem[]) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it));
    if (kind === 'personal') setPersonal(updater);
    else setEquipo(updater);
  }
  function removeItem(kind: 'personal' | 'equipo', id: string) {
    if (kind === 'personal') setPersonal((prev) => prev.filter((it) => it.id !== id));
    else setEquipo((prev) => prev.filter((it) => it.id !== id));
  }
  function incQty(kind: 'personal' | 'equipo', id: string, delta: number) {
    const target = kind === 'personal' ? personal : equipo;
    const cur = target.find((it) => it.id === id);
    if (!cur) return;
    const next = Math.max(1, (cur.qty || 1) + delta);
    updateItem(kind, id, { qty: next });
  }

  function serializeItems(items: DynItem[]): string[] {
    return items
      .filter((it) => (it.desc || '').trim().length > 0)
      .map((it) => `${Math.max(1, it.qty || 1)} ${it.desc.trim()}`);
  }

  // -------------------------------------------------------------------------
  // Envío.
  const primeraLecturaNum = parseFloatOrNull(primeraLectura);
  const ultimaLecturaNum = parseFloatOrNull(ultimaLectura);

  // Avance calculado en vivo (Última − Primera) con 2 decimales máximo.
  const avanceStr: string | null = useMemo(() => {
    if (primeraLecturaNum == null || ultimaLecturaNum == null) return null;
    return fmtNum2(ultimaLecturaNum - primeraLecturaNum);
  }, [primeraLecturaNum, ultimaLecturaNum]);

  const canSubmit = !!leafNode && !!project
    && validateMeasurement(leafNode.measurement_type, measurement)
    && !submitting;

  async function onSubmit() {
    if (!leafNode || !project) return;
    if (!validateMeasurement(leafNode.measurement_type, measurement)) {
      notify('Falta el valor de medición', `Captura el valor requerido (${MEASUREMENT_LABELS[leafNode.measurement_type as MeasurementType] || leafNode.measurement_type}) antes de finalizar.`);
      return;
    }
    setSubmitting(true);
    try {
      const personnelArr = serializeItems(personal);
      const equipmentArr = serializeItems(equipo);

      await api.createReport({
        project_id: project.id,
        node_id: leafNode.id,
        measurement_value: measurement,
        notes: actividades.trim() || null, // legacy notes = actividades
        // [P0 FIX] avance ahora envía el string calculado + unidad (no actividades).
        avance: avanceStr != null ? `${avanceStr} ${unidad}` : null,
        observaciones: observaciones.trim() || null,
        contratista: null, // Deprecado: ahora se usa project.constructora global.
        personnel: personnelArr,
        equipment: equipmentArr,
        images: images,
        primera_lectura: primeraLecturaNum,
        ultima_lectura: ultimaLecturaNum,
        unidad: unidad,
      });

      // Actualizar catálogo local (autocomplete).
      await addToCatalog('personal', personal.map((p) => p.desc));
      await addToCatalog('equipo', equipo.map((e) => e.desc));

      // Construir mensaje WhatsApp.
      const areaOrPuesto = (user?.puesto || user?.area || '').trim();
      const ubicacion = formatMeasurementValue(leafNode.measurement_type || '', measurement);
      const msg = buildWhatsAppMessage({
        userName: user?.name || '',
        areaOrPuesto,
        contractNumber: contratoEfectivo || project.contract_number,
        parentNodeName: parentOfLeaf?.name || '',
        leafNodeName: leafNode.name,
        ubicacion,
        constructora: contratistaEfectivo || project.constructora || '',
        personal: personnelArr,
        equipo: equipmentArr,
        actividades: actividades.trim(),
        observaciones: observaciones.trim(),
        primeraLectura: primeraLecturaNum,
        ultimaLectura: ultimaLecturaNum,
        unidad: unidad,
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
    setActividades('');
    setObservaciones('');
    setPrimeraLectura('');
    setUltimaLectura('');
    setPersonal([]);
    setEquipo([]);
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

  async function sendViaWhatsApp() {
    const encoded = encodeURIComponent(waMessage);
    const native = `whatsapp://send?text=${encoded}`;
    const fallback = `https://wa.me/?text=${encoded}`;
    try {
      const canOpen = await Linking.canOpenURL(native);
      if (canOpen) {
        await Linking.openURL(native);
      } else {
        await Linking.openURL(fallback);
      }
    } catch (e: any) {
      try {
        await Linking.openURL(fallback);
      } catch (e2: any) {
        notify('WhatsApp', e2?.message || e?.message || 'No se pudo abrir WhatsApp');
      }
    }
  }

  async function onLogout() {
    const ok = await confirm('Cerrar sesión', '¿Seguro que deseas salir? Cualquier foto sin enviar se descartará.', { confirmText: 'Salir', destructive: true });
    if (!ok) return;
    setImages([]);
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

  // Sub-coordinador SIEMPRE tiene acceso global: NUNCA mostrar "Sin nodos asignados".
  const noAllowedLeaves = !isSubCoord && allowedLeafIds.size === 0;
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
        contentContainerStyle={{ padding: spacing.md, paddingBottom: insets.bottom + spacing.xl + 20 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {/* AUTO-DATA (read-only) */}
        <SectionCard
          icon="information-circle-outline"
          title="Datos del reporte"
          subtitle="Información automática, no editable."
        >
          <View style={styles.autoGrid}>
            <AutoRow icon="calendar-outline" label="Fecha" value={formatDateLongES(new Date()).replace(/\.$/, '')} />
            <AutoRow icon="person-outline" label="Capturado por" value={`Ing. ${user?.name || ''}`.trim()} />
            <AutoRow icon="briefcase-outline" label="Rol" value={roleLabel(user?.role, user?.area)} />
            {user?.puesto ? <AutoRow icon="ribbon-outline" label="Puesto" value={user.puesto} /> : null}
            <AutoRow icon="document-attach-outline" label="No. de contrato" value={project?.contract_number || '—'} />
            <AutoRow icon="git-branch-outline" label="Ubicación" value={ubicacionPathLabel} />
          </View>
        </SectionCard>

        {/* Cascada */}
        <SectionCard
          icon="navigate-outline"
          title="Selecciona ubicación"
          subtitle="Navega hasta el nodo hoja autorizado."
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

        {/* Coordenadas objetivo */}
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
                <Text style={styles.coordsTargetLabel}>Coordenada X (Este)</Text>
                <Text style={styles.coordsTargetValue} numberOfLines={1}>
                  {(leafNode as any).target_lat != null ? String((leafNode as any).target_lat) : '—'}
                </Text>
              </View>
              <View style={styles.coordsTargetItem}>
                <Text style={styles.coordsTargetLabel}>Coordenada Y (Norte)</Text>
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
            subtitle="Captura el valor que define este nodo."
          >
            <MeasurementInput
              type={leafNode.measurement_type as MeasurementType}
              value={measurement}
              onChange={setMeasurement}
            />
          </SectionCard>
        ) : null}

        {/* Lecturas P/U */}
        {leafNode ? (
          <SectionCard
            icon="analytics-outline"
            title="Lecturas"
            subtitle="Captura la primera y última lectura del día."
          >
            {/* Selector de Unidades — pills [km | m | cm] */}
            <Field label="Unidad de medida">
              <View style={styles.unidadRow}>
                {UNIDAD_OPTIONS.map((u) => {
                  const active = unidad === u;
                  return (
                    <Pressable
                      key={u}
                      onPress={() => setUnidad(u)}
                      style={[styles.unidadPill, active && styles.unidadPillActive]}
                      hitSlop={6}
                    >
                      <Text style={[styles.unidadPillTxt, active && styles.unidadPillTxtActive]}>
                        {u}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>

            <Field label="Primera lectura">
              <TextInput
                placeholder="Ej. 12.45"
                placeholderTextColor={colors.textMuted}
                keyboardType="numeric"
                style={styles.input}
                value={primeraLectura}
                onChangeText={setPrimeraLectura}
              />
              {/* Helper histórico SOLO debajo de Primera lectura */}
              {nodeHistoryLoading ? (
                <Text style={styles.histHelperMuted}>Buscando histórico…</Text>
              ) : nodeHistory && nodeHistory.has_previous && nodeHistory.ultima_lectura != null ? (
                <View style={styles.histHelperBox}>
                  <Ionicons name="time-outline" size={13} color={colors.primary} />
                  <Text style={styles.histHelperTxt}>
                    Última lectura registrada en este nodo:{' '}
                    <Text style={styles.histHelperVal}>{String(nodeHistory.ultima_lectura)}</Text>
                  </Text>
                </View>
              ) : nodeHistory && !nodeHistory.has_previous ? (
                <Text style={styles.histHelperMuted}>Sin lecturas previas en este nodo.</Text>
              ) : null}
            </Field>

            <Field label="Última lectura">
              <TextInput
                placeholder="Ej. 12.80"
                placeholderTextColor={colors.textMuted}
                keyboardType="numeric"
                style={styles.input}
                value={ultimaLectura}
                onChangeText={setUltimaLectura}
              />
            </Field>

            {/* Avance calculado en vivo = Última - Primera */}
            {avanceStr != null ? (
              <View style={styles.avanceBox}>
                <Ionicons name="trending-up" size={16} color={colors.primary} />
                <Text style={styles.avanceLabel}>Avance:</Text>
                <Text style={styles.avanceValue}>{avanceStr} {unidad}</Text>
              </View>
            ) : (primeraLectura.trim() !== '' || ultimaLectura.trim() !== '') ? (
              <Text style={styles.histHelperMuted}>
                Captura ambas lecturas (Primera y Última) para calcular el avance.
              </Text>
            ) : null}
          </SectionCard>
        ) : null}

        {/* Reporte: Actividades / Observaciones / Contratista */}
        {leafNode ? (
          <SectionCard icon="document-text-outline" title="Reporte" subtitle="Actividades, observaciones y contratista.">
            <Field label="Contratista">
              <TextInput
                placeholder="Nombre del contratista"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={contratistaText}
                onChangeText={setContratistaText}
              />
            </Field>

            <Field label="No. de contrato">
              <TextInput
                placeholder="Ej. CONT-2026-001"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={contratoText}
                onChangeText={setContratoText}
              />
            </Field>

            <Field label="Actividades">
              <TextInput
                placeholder="Describe las actividades del día…"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.inputMulti]}
                multiline
                numberOfLines={4}
                value={actividades}
                onChangeText={setActividades}
              />
            </Field>

            <Field label="Observaciones">
              <TextInput
                placeholder="Comentarios, incidencias, retrasos…"
                placeholderTextColor={colors.textMuted}
                style={[styles.input, styles.inputMulti]}
                multiline
                numberOfLines={4}
                value={observaciones}
                onChangeText={setObservaciones}
              />
            </Field>

          </SectionCard>
        ) : null}

        {/* Personal dinámico */}
        {leafNode ? (
          <DynamicListSection
            title="Personal"
            subtitle="Cantidad + descripción (ej. 3 Albañiles)."
            icon="people-outline"
            items={personal}
            catalog={catalogPersonal}
            onAdd={() => addItem('personal')}
            onRemove={(id) => removeItem('personal', id)}
            onInc={(id, d) => incQty('personal', id, d)}
            onChangeDesc={(id, t) => updateItem('personal', id, { desc: t })}
            onChangeQty={(id, q) => updateItem('personal', id, { qty: q })}
          />
        ) : null}

        {/* Equipo dinámico */}
        {leafNode ? (
          <DynamicListSection
            title="Equipo"
            subtitle="Cantidad + descripción (ej. 1 Retro CAT 320)."
            icon="construct-outline"
            items={equipo}
            catalog={catalogEquipo}
            onAdd={() => addItem('equipo')}
            onRemove={(id) => removeItem('equipo', id)}
            onInc={(id, d) => incQty('equipo', id, d)}
            onChangeDesc={(id, t) => updateItem('equipo', id, { desc: t })}
            onChangeQty={(id, q) => updateItem('equipo', id, { qty: q })}
          />
        ) : null}

        {/* Fotos */}
        {leafNode ? (
          <SectionCard
            icon="camera-outline"
            title={`Fotos (${images.length})`}
            subtitle="Cero Huella Local: las imágenes viven solo en RAM."
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
              label={submitting ? 'Enviando…' : 'Guardar reporte'}
              onPress={onSubmit}
              loading={submitting}
              disabled={!canSubmit}
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
                Tus datos y fotos se guardaron en la base. Copia el texto o ábrelo directo en WhatsApp.
              </Text>
            </View>
            <ScrollView style={styles.successPreview} contentContainerStyle={{ padding: spacing.md }}>
              <Text style={styles.successPreviewTxt}>{waMessage}</Text>
            </ScrollView>
            <View style={{ gap: spacing.sm }}>
              <Button
                label="Enviar por WhatsApp"
                onPress={sendViaWhatsApp}
                fullWidth
                icon={<Ionicons name="logo-whatsapp" size={18} color="#fff" />}
              />
              <Button
                label="Copiar texto"
                variant="secondary"
                onPress={copyWhatsAppToClipboard}
                fullWidth
                icon={<Ionicons name="copy-outline" size={18} color={colors.primary} />}
              />
              <Button
                label="Nueva captura"
                variant="ghost"
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
// Sección de listas dinámicas (Personal / Equipo) con autocomplete.
// ============================================================================
function DynamicListSection({
  title, subtitle, icon, items, catalog,
  onAdd, onRemove, onInc, onChangeDesc, onChangeQty,
}: {
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
  items: DynItem[];
  catalog: string[];
  onAdd: () => void;
  onRemove: (id: string) => void;
  onInc: (id: string, delta: number) => void;
  onChangeDesc: (id: string, t: string) => void;
  onChangeQty: (id: string, q: number) => void;
}) {
  return (
    <SectionCard icon={icon} title={`${title} (${items.length})`} subtitle={subtitle}>
      {items.length === 0 ? (
        <Text style={styles.emptyInlineTxt}>Aún no agregaste items. Toca “Agregar” para iniciar.</Text>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((it) => (
            <DynamicItemRow
              key={it.id}
              item={it}
              catalog={catalog}
              onRemove={() => onRemove(it.id)}
              onInc={(d) => onInc(it.id, d)}
              onChangeDesc={(t) => onChangeDesc(it.id, t)}
              onChangeQty={(q) => onChangeQty(it.id, q)}
            />
          ))}
        </View>
      )}
      <Pressable onPress={onAdd} style={styles.addItemBtn} hitSlop={6}>
        <Ionicons name="add" size={18} color={colors.primary} />
        <Text style={styles.addItemBtnTxt}>Agregar {title.toLowerCase()}</Text>
      </Pressable>
    </SectionCard>
  );
}

function DynamicItemRow({
  item, catalog, onRemove, onInc, onChangeDesc, onChangeQty,
}: {
  item: DynItem;
  catalog: string[];
  onRemove: () => void;
  onInc: (delta: number) => void;
  onChangeDesc: (t: string) => void;
  onChangeQty: (q: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const suggestions = useMemo(() => {
    const q = (item.desc || '').trim().toLowerCase();
    if (!q) return catalog.slice(0, 6);
    return catalog
      .filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q)
      .slice(0, 6);
  }, [catalog, item.desc]);

  return (
    <View style={styles.dynRow}>
      <View style={styles.dynQtyBox}>
        <Pressable onPress={() => onInc(-1)} style={styles.qtyBtn} hitSlop={6} disabled={item.qty <= 1}>
          <Ionicons name="remove" size={16} color={item.qty <= 1 ? colors.textMuted : colors.text} />
        </Pressable>
        <TextInput
          style={styles.qtyInput}
          keyboardType="number-pad"
          value={String(item.qty)}
          onChangeText={(t) => {
            const n = parseInt(t.replace(/[^0-9]/g, ''), 10);
            onChangeQty(Number.isFinite(n) && n > 0 ? n : 1);
          }}
        />
        <Pressable onPress={() => onInc(1)} style={styles.qtyBtn} hitSlop={6}>
          <Ionicons name="add" size={16} color={colors.text} />
        </Pressable>
      </View>
      <View style={{ flex: 1, position: 'relative' }}>
        <TextInput
          style={styles.dynDescInput}
          placeholder="Descripción (ej. Albañil)"
          placeholderTextColor={colors.textMuted}
          value={item.desc}
          onChangeText={onChangeDesc}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
        />
        {focused && suggestions.length > 0 ? (
          <View style={styles.suggestionsBox}>
            {suggestions.map((s) => (
              <Pressable
                key={s}
                // onPressIn evita el race-condition con setTimeout(setFocused(false),120) del onBlur del input
                onPressIn={() => { onChangeDesc(s); setFocused(false); }}
                style={({ pressed }) => [styles.suggestionItem, pressed && { backgroundColor: colors.primaryLight }]}
              >
                <Ionicons name="bookmark-outline" size={12} color={colors.primary} />
                <Text style={styles.suggestionTxt} numberOfLines={1}>{s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      <Pressable onPress={onRemove} style={styles.removeBtn} hitSlop={6}>
        <Ionicons name="trash-outline" size={16} color={colors.error} />
      </Pressable>
    </View>
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

function AutoRow({ icon, label, value }: { icon: keyof typeof Ionicons.glyphMap; label: string; value: string }) {
  return (
    <View style={styles.autoRow}>
      <Ionicons name={icon} size={14} color={colors.primary} style={{ marginRight: 8 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.autoLabel}>{label}</Text>
        <Text style={styles.autoValue} numberOfLines={2}>{value || '—'}</Text>
      </View>
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
          <Field label="Latitud (X) · precargada">
            <TextInput
              editable={false}
              selectTextOnFocus={false}
              keyboardType="numeric"
              placeholder="Asignada por Coordinador"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.inputDisabled]}
              value={value.lat != null ? String(value.lat) : ''}
            />
          </Field>
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Longitud (Y) · precargada">
            <TextInput
              editable={false}
              selectTextOnFocus={false}
              keyboardType="numeric"
              placeholder="Asignada por Coordinador"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.inputDisabled]}
              value={value.lon != null ? String(value.lon) : ''}
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
function parseFloatSafe(t: string): number | string {
  const cleaned = t.replace(',', '.').trim();
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return cleaned;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : cleaned;
}

function parseFloatOrNull(t: string): number | null {
  const cleaned = (t || '').replace(',', '.').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function validateMeasurement(type: string | null | undefined, v: MeasurementValue): boolean {
  if (!type) return false;
  if (type === 'coord_latlon') {
    return typeof v.lat === 'number' && typeof v.lon === 'number'
      && Number.isFinite(v.lat) && Number.isFinite(v.lon);
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

  // Auto-data
  autoGrid: { gap: 8 },
  autoRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: radius.md, padding: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  autoLabel: { fontSize: 10, fontWeight: '800', color: colors.textMuted, letterSpacing: 0.4, textTransform: 'uppercase' },
  autoValue: { fontSize: 13, fontWeight: '700', color: colors.text, marginTop: 2 },

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
  inputMulti: { minHeight: 90, textAlignVertical: 'top' },

  selectorBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  selectorBtnTxt: { flex: 1, fontSize: 15, color: colors.text },

  // Selector de unidades (pills)
  unidadRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  unidadPill: {
    flex: 1,
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 44,
  },
  unidadPillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  unidadPillTxt: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textBody,
    textTransform: 'lowercase',
    letterSpacing: 0.5,
  },
  unidadPillTxtActive: {
    color: colors.textInverse,
  },

  // Avance calculado en vivo
  avanceBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    padding: 10,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  avanceLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.textBody,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  avanceValue: {
    fontSize: 16,
    fontWeight: '800',
    color: colors.primary,
    marginLeft: 'auto',
  },

  // Helper de histórico para Primera lectura
  histHelperBox: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 6,
    padding: 8,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
  },
  histHelperTxt: { fontSize: 12, color: colors.textBody, flex: 1 },
  histHelperVal: { fontWeight: '800', color: colors.primary },
  histHelperMuted: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontStyle: 'italic' },

  // Dynamic list
  dynRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  dynQtyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    height: 44,
  },
  qtyBtn: {
    width: 32, height: 44,
    alignItems: 'center', justifyContent: 'center',
  },
  qtyInput: {
    width: 36, height: 44,
    textAlign: 'center',
    color: colors.text,
    fontWeight: '800',
    fontSize: 14,
    paddingVertical: 0,
  },
  dynDescInput: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 14,
    color: colors.text,
    height: 44,
  },
  removeBtn: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addItemBtn: {
    marginTop: spacing.sm,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6,
    paddingVertical: 10, paddingHorizontal: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.primary, borderStyle: 'dashed',
  },
  addItemBtnTxt: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  emptyInlineTxt: { fontSize: 12, color: colors.textMuted, fontStyle: 'italic', paddingVertical: 4 },

  suggestionsBox: {
    position: 'absolute',
    top: 48,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    zIndex: 10,
    ...shadow.card,
  },
  suggestionItem: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 8,
  },
  suggestionTxt: { fontSize: 13, color: colors.text, flex: 1 },

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

  // Coordenadas objetivo
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
