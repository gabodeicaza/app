import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  Image,
  Alert,
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  Modal,
  FlatList,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { StampedPhotoModal } from '@/src/components/StampedPhotoModal';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { useSync } from '@/src/sync-context';
import { colors, radius, spacing } from '@/src/theme';
import { getPosteCoord, posteLocationName } from '@/src/utils/posteCoords';

const { width } = Dimensions.get('window');
const THUMB = (width - spacing.md * 2 - spacing.sm * 2) / 3;

type Unit = 'm3' | 'm' | 'cm' | 'mm' | 'km' | 'none';
const UNITS: { value: Unit; label: string }[] = [
  { value: 'none', label: '—' },
  { value: 'mm', label: 'mm' },
  { value: 'cm', label: 'cm' },
  { value: 'm', label: 'm' },
  { value: 'km', label: 'km' },
  { value: 'm3', label: 'm³' },
];

const PRIORITIES: { value: 1 | 2 | 3; label: string; color: string; bg: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { value: 1, label: 'Informativo', color: '#0369A1', bg: '#E0F2FE', icon: 'information-circle' },
  { value: 2, label: 'Importante', color: '#B45309', bg: '#FEF3C7', icon: 'alert-circle' },
  { value: 3, label: 'Urgente', color: '#B91C1C', bg: '#FEE2E2', icon: 'warning' },
];

interface RefPoint {
  id: string;
  name: string;
  location?: string | null;
  coordinates?: string | null;
  area?: string | null;
  areaName?: string | null;
}

interface SiteConfig {
  contract: string;
  contractor: string;
}

function formatDate(iso?: string) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

export default function NewReport() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { online, enqueue, syncNow } = useSync();

  // ----- Auto-populated header -----
  const [areaName, setAreaName] = useState('');
  const [siteCfg, setSiteCfg] = useState<SiteConfig>({ contract: '', contractor: '' });

  // ----- Reference Points -----
  const [refPoints, setRefPoints] = useState<RefPoint[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<RefPoint | null>(null);
  const [coordinates, setCoordinates] = useState('');
  const [locationName, setLocationName] = useState('');
  const [pointPickerOpen, setPointPickerOpen] = useState(false);
  const [newPointModalOpen, setNewPointModalOpen] = useState(false);
  const [newPointName, setNewPointName] = useState('');
  const [newPointLocation, setNewPointLocation] = useState('');
  const [newPointCoords, setNewPointCoords] = useState('');
  const [creatingPoint, setCreatingPoint] = useState(false);

  // ----- Readings & Progress -----
  const [firstReading, setFirstReading] = useState('');
  const [lastReading, setLastReading] = useState('');
  const [unit, setUnit] = useState<Unit>('m');
  const [noAplicaLecturas, setNoAplicaLecturas] = useState(false);

  // ----- Activities -----
  const [activities, setActivities] = useState('');

  // ----- Personnel / Equipment -----
  const [personnel, setPersonnel] = useState<string[]>([]);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [personnelDraft, setPersonnelDraft] = useState('');
  const [equipmentDraft, setEquipmentDraft] = useState('');

  // History suggestions
  const [histPersonnel, setHistPersonnel] = useState<string[]>([]);
  const [histEquipment, setHistEquipment] = useState<string[]>([]);
  const [histActivities, setHistActivities] = useState<string[]>([]);

  // ----- Existing fields -----
  const [title, setTitle] = useState('');
  const [comments, setComments] = useState('');
  const [priority, setPriority] = useState<1 | 2 | 3>(1);
  const [images, setImages] = useState<string[]>([]);

  // --- Jerarquía de Ubicación (obligatoria) ---
  const [tramo, setTramo] = useState<1 | 2 | null>(null);
  const [estacion, setEstacion] = useState<number | null>(null);
  const [poste, setPoste] = useState<number | null>(null);

  // Sello anti-fraude: imagen pendiente de aplicar marca (data URL en RAM)
  const [pendingStampBase64, setPendingStampBase64] = useState<string | null>(null);

  // Archivos adjuntos (Cero Huella Local: base64 en RAM, no se guardan a galería)
  const [files, setFiles] = useState<Array<{ name: string; mimeType: string; dataUrl: string; size?: number }>>([]);

  const [submitting, setSubmitting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(true);

  const scrollRef = useRef<ScrollView | null>(null);

  // Initial data load
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoadingMeta(true);
      try {
        const [areas, points, cfg, history] = await Promise.all([
          api.listAreas().catch(() => []),
          api.listReferencePoints().catch(() => [] as RefPoint[]),
          api.getSiteConfig().catch(() => ({ contract: '', contractor: '' })),
          api.reportHistory().catch(() => ({ personnel: [], equipment: [], activities: [] } as any)),
        ]);
        if (!alive) return;
        const a = (areas as any[]).find((x) => x.id === user?.area);
        if (a) setAreaName(a.name);
        setRefPoints(points as RefPoint[]);
        setSiteCfg({ contract: cfg.contract || '', contractor: cfg.contractor || '' });
        setHistPersonnel(history.personnel || []);
        setHistEquipment(history.equipment || []);
        setHistActivities(history.activities || []);
      } catch {
        // silent
      } finally {
        if (alive) setLoadingMeta(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [user?.area]);

  // Georreferenciación automática: cuando cambian Tramo/Estación/Poste,
  // auto-vincula Lat/Lng + nombre de ubicación desde el diccionario mock.
  // Cero Huella Local: utilidad pura en memoria, sin disco.
  useEffect(() => {
    const c = getPosteCoord(tramo, estacion, poste);
    if (c) {
      setCoordinates(c.label);
      setLocationName(posteLocationName(tramo, estacion, poste));
    } else {
      setCoordinates('');
      setLocationName('');
    }
  }, [tramo, estacion, poste]);

  // Auto-calculate progress (avance)
  const progress = useMemo(() => {
    const a = parseFloat(firstReading.replace(',', '.'));
    const b = parseFloat(lastReading.replace(',', '.'));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) * 10000) / 10000;
  }, [firstReading, lastReading]);

  // Reference points sorted (area-specific first, then global)
  const sortedRefPoints = useMemo(() => {
    const mine = refPoints.filter((p) => p.area === user?.area);
    const globals = refPoints.filter((p) => !p.area);
    return [...mine, ...globals];
  }, [refPoints, user?.area]);

  // Autocomplete suggestions filtered by draft & not already added
  const personnelSuggestions = useMemo(() => {
    const q = personnelDraft.trim().toLowerCase();
    if (!q) return [];
    return histPersonnel
      .filter((p) => p.toLowerCase().includes(q) && !personnel.includes(p))
      .slice(0, 6);
  }, [personnelDraft, histPersonnel, personnel]);

  const equipmentSuggestions = useMemo(() => {
    const q = equipmentDraft.trim().toLowerCase();
    if (!q) return [];
    return histEquipment
      .filter((e) => e.toLowerCase().includes(q) && !equipment.includes(e))
      .slice(0, 6);
  }, [equipmentDraft, histEquipment, equipment]);

  // --------- Image handling (Cero Huella Local: solo RAM) ---------
  async function wipeTemp(uri?: string | null) {
    if (!uri || !uri.startsWith('file:')) return;
    try {
      await FileSystem.deleteAsync(uri, { idempotent: true });
    } catch {
      // best effort
    }
  }

  async function pickFromGallery() {
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    let canAsk = perm.canAskAgain;
    let status = perm.status;
    if (status !== 'granted' && canAsk) {
      const r = await ImagePicker.requestMediaLibraryPermissionsAsync();
      status = r.status;
      canAsk = r.canAskAgain;
    }
    if (status !== 'granted') {
      Alert.alert(
        'Permiso requerido',
        'Necesitamos acceso a tu galería para agregar fotos al reporte.',
        [
          { text: 'Cancelar', style: 'cancel' },
          ...(canAsk ? [] : [{ text: 'Abrir Ajustes', onPress: () => Linking.openSettings() }]),
        ],
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: 12,
      quality: 0.6,
      base64: true,
    });
    if (result.canceled) return;
    const items: string[] = [];
    for (const a of result.assets) {
      if (a.base64) items.push(`data:image/jpeg;base64,${a.base64}`);
      // Cero Huella Local: borrar copia temporal del picker, conservar solo base64 en RAM.
      void wipeTemp(a.uri);
    }
    setImages((prev) => [...prev, ...items].slice(0, 20));
    void Haptics.selectionAsync();
  }

  async function takePhoto() {
    const perm = await ImagePicker.getCameraPermissionsAsync();
    let canAsk = perm.canAskAgain;
    let status = perm.status;
    if (status !== 'granted' && canAsk) {
      const r = await ImagePicker.requestCameraPermissionsAsync();
      status = r.status;
      canAsk = r.canAskAgain;
    }
    if (status !== 'granted') {
      Alert.alert(
        'Permiso requerido',
        'Activa la cámara para capturar evidencia.',
        [
          { text: 'Cancelar', style: 'cancel' },
          ...(canAsk ? [] : [{ text: 'Abrir Ajustes', onPress: () => Linking.openSettings() }]),
        ],
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      quality: 0.6,
      base64: true,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset?.base64) return;
    const item = `data:image/jpeg;base64,${asset.base64}`;
    // Cero Huella Local: borrar copia temporal del picker después de extraer base64.
    void wipeTemp(asset.uri);
    // Sello anti-fraude: abrir modal para incrustar GPS + fecha + hora antes de agregar.
    setPendingStampBase64(item);
    void Haptics.selectionAsync();
  }

  function removeImage(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ---------- Archivos adjuntos (Cero Huella Local) ----------
  const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB por archivo

  async function pickDocument() {
    if (files.length >= 5) {
      Alert.alert('Límite alcanzado', 'Máximo 5 archivos por reporte.');
      return;
    }
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/vnd.ms-excel',
               'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
               'application/msword',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
               'text/csv', 'image/*'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const asset = res.assets[0];
      if (!asset?.uri) return;
      if (asset.size && asset.size > MAX_FILE_BYTES) {
        Alert.alert('Archivo muy grande', 'Máximo 8 MB por archivo.');
        void wipeTemp(asset.uri);
        return;
      }
      const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' });
      const mime = asset.mimeType || 'application/octet-stream';
      const dataUrl = `data:${mime};base64,${b64}`;
      setFiles((prev) => [...prev, {
        name: asset.name || 'archivo',
        mimeType: mime,
        dataUrl,
        size: asset.size,
      }]);
      // Cero Huella Local: borra la copia temporal del picker.
      void wipeTemp(asset.uri);
      void Haptics.selectionAsync();
    } catch (e: any) {
      Alert.alert('No se pudo adjuntar', e?.message || 'Intenta de nuevo.');
    }
  }

  async function scanDocument() {
    if (files.length >= 5) {
      Alert.alert('Límite alcanzado', 'Máximo 5 archivos por reporte.');
      return;
    }
    const perm = await ImagePicker.getCameraPermissionsAsync();
    let granted = perm.status === 'granted';
    if (!granted && perm.canAskAgain) {
      const ask = await ImagePicker.requestCameraPermissionsAsync();
      granted = ask.status === 'granted';
    }
    if (!granted) {
      Alert.alert(
        'Permiso de cámara denegado',
        'Habilita la cámara en Ajustes para escanear documentos.',
        [{ text: 'Cancelar' }, { text: 'Abrir Ajustes', onPress: () => Linking.openSettings() }],
      );
      return;
    }
    try {
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        base64: true,
        allowsEditing: true,           // permite recortar para "escanear"
        aspect: [3, 4],
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const b64 = asset?.base64;
      if (!b64) return;
      const ts = new Date();
      const pad = (n: number) => (n < 10 ? '0' + n : String(n));
      const name = `escaneo-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.jpg`;
      setFiles((prev) => [...prev, {
        name,
        mimeType: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${b64}`,
        size: b64.length,
      }]);
      // Cero Huella Local: borrar archivo temporal del picker.
      void wipeTemp(asset.uri);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('No se pudo escanear', e?.message || 'Intenta de nuevo.');
    }
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function fileKindIcon(mime: string): string {
    if (mime.includes('pdf')) return 'document-text';
    if (mime.includes('sheet') || mime.includes('excel') || mime.includes('csv')) return 'grid';
    if (mime.includes('word')) return 'document';
    if (mime.startsWith('image/')) return 'image';
    return 'attach';
  }

  function fmtBytes(n?: number): string {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }

  // --------- Reference point handlers ---------
  function selectPoint(p: RefPoint) {
    setSelectedPoint(p);
    setCoordinates(p.coordinates || '');
    setLocationName(p.location || '');
    setPointPickerOpen(false);
    void Haptics.selectionAsync();
  }

  function clearPoint() {
    setSelectedPoint(null);
    setCoordinates('');
    setLocationName('');
  }

  async function createNewPoint() {
    const nm = newPointName.trim();
    if (!nm) {
      Alert.alert('Nombre requerido', 'Ingresa un nombre (Ej. Poste 12).');
      return;
    }
    if (!online) {
      Alert.alert('Sin conexión', 'Conecta a internet para crear nuevos puntos de referencia.');
      return;
    }
    setCreatingPoint(true);
    try {
      const created = await api.createReferencePoint({
        name: nm,
        location: newPointLocation.trim() || null,
        coordinates: newPointCoords.trim() || null,
        area: user?.area || null,
      });
      setRefPoints((prev) => [...prev, created]);
      selectPoint(created);
      setNewPointModalOpen(false);
      setNewPointName('');
      setNewPointLocation('');
      setNewPointCoords('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('No se pudo crear', e?.message || 'Intenta de nuevo.');
    } finally {
      setCreatingPoint(false);
    }
  }

  // --------- Personnel / Equipment chip handlers ---------
  function addPersonnel(value?: string) {
    const v = (value ?? personnelDraft).trim();
    if (!v) return;
    if (personnel.includes(v)) {
      setPersonnelDraft('');
      return;
    }
    setPersonnel((prev) => [...prev, v]);
    setPersonnelDraft('');
    void Haptics.selectionAsync();
  }
  function removePersonnel(name: string) {
    setPersonnel((prev) => prev.filter((p) => p !== name));
  }
  function addEquipment(value?: string) {
    const v = (value ?? equipmentDraft).trim();
    if (!v) return;
    if (equipment.includes(v)) {
      setEquipmentDraft('');
      return;
    }
    setEquipment((prev) => [...prev, v]);
    setEquipmentDraft('');
    void Haptics.selectionAsync();
  }
  function removeEquipment(name: string) {
    setEquipment((prev) => prev.filter((e) => e !== name));
  }

  // --------- AI improve ---------
  async function improveWithAI() {
    if (!title.trim() && !comments.trim()) {
      Alert.alert('Sin contenido', 'Escribe un título o un comentario antes de mejorar el texto.');
      return;
    }
    if (!user?.area) return;
    setAiLoading(true);
    try {
      const r = await api.improveText(title, comments, user.area);
      setComments(r.text);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('IA no disponible', e?.message || 'Intenta más tarde.');
    } finally {
      setAiLoading(false);
    }
  }

  // --------- Submit ---------
  async function submit() {
    if (!title.trim()) {
      Alert.alert('Título requerido', 'Escribe un título corto del reporte.');
      return;
    }
    if (!user?.area) {
      Alert.alert('Sin área', 'Tu cuenta no tiene un área asignada.');
      return;
    }
    if (!tramo || !estacion || !poste) {
      Alert.alert(
        'Ubicación incompleta',
        'Selecciona Tramo, Estación y Poste antes de enviar el reporte.',
      );
      return;
    }
    setSubmitting(true);
    const firstNum = noAplicaLecturas
      ? null
      : firstReading.trim()
        ? parseFloat(firstReading.replace(',', '.'))
        : null;
    const lastNum = noAplicaLecturas
      ? null
      : lastReading.trim()
        ? parseFloat(lastReading.replace(',', '.'))
        : null;
    const payload: any = {
      title: title.trim(),
      comments: comments.trim(),
      area: user.area,
      images,
      priority,
      tramo,
      estacion,
      poste,
      reference_point_id: selectedPoint?.id || null,
      reference_point_name: selectedPoint?.name || null,
      location: locationName.trim() || null,
      coordinates: coordinates.trim() || null,
      first_reading: Number.isFinite(firstNum as number) ? firstNum : null,
      last_reading: Number.isFinite(lastNum as number) ? lastNum : null,
      unit: noAplicaLecturas ? 'none' : unit,
      activities: activities.trim() || null,
      personnel,
      equipment,
      files,
    };
    try {
      if (online) {
        await api.createReport(payload);
      } else {
        await enqueue({
          title: payload.title,
          comments: payload.comments,
          area: payload.area,
          areaName,
          images: payload.images,
          location: payload.location,
          reference_point_id: payload.reference_point_id,
          reference_point_name: payload.reference_point_name,
          coordinates: payload.coordinates,
          first_reading: payload.first_reading,
          last_reading: payload.last_reading,
          unit: payload.unit,
          activities: payload.activities,
          personnel: payload.personnel,
          equipment: payload.equipment,
          files: payload.files,
          tramo: payload.tramo,
          estacion: payload.estacion,
          poste: payload.poste,
          priority: payload.priority,
        } as any);
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        online ? 'Reporte enviado' : 'Guardado localmente',
        online ? 'Tu reporte se sincronizó.' : 'Se enviará automáticamente al recuperar conexión.',
      );
      // Reset (Cero Huella Local: limpieza inmediata de evidencias en memoria)
      setTitle('');
      setComments('');
      setImages([]);
      setFiles([]);
      setPendingStampBase64(null);
      setActivities('');
      setFirstReading('');
      setLastReading('');
      setNoAplicaLecturas(false);
      setPersonnel([]);
      setEquipment([]);
      setSelectedPoint(null);
      setCoordinates('');
      setLocationName('');
      setPriority(1);
      setTramo(null);
      setEstacion(null);
      setPoste(null);
      router.replace('/(especialista)');
      if (online) void syncNow();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'No se pudo crear el reporte.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Nuevo reporte" subtitle={areaName || 'Mi área'} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={scrollRef}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        >
          {/* === HEADER (Auto-populated) === */}
          <View style={[styles.card, styles.headerCard]}>
            <View style={styles.headerTitleRow}>
              <Ionicons name="document-text" size={16} color={colors.primary} />
              <Text style={styles.headerTitle}>Datos del reporte</Text>
            </View>
            <HeaderRow icon="calendar-outline" label="Fecha" value={formatDate()} />
            <HeaderRow icon="person-outline" label="Especialista" value={user?.name || '—'} />
            <HeaderRow icon="briefcase-outline" label="Puesto" value={user?.puesto || '—'} />
            <HeaderRow icon="document-attach-outline" label="Contrato" value={siteCfg.contract || (loadingMeta ? '…' : 'No configurado')} muted={!siteCfg.contract} />
            <HeaderRow icon="business-outline" label="Contratista" value={siteCfg.contractor || (loadingMeta ? '…' : 'No configurado')} muted={!siteCfg.contractor} />
          </View>

          {/* === UBICACIÓN CABLEBÚS (Tramo / Estación / Poste) === */}
          <View style={styles.card}>
            <Text style={styles.headerTitle}>Ubicación Cablebús</Text>
            <Text style={[styles.subLabel, { marginBottom: 8 }]}>
              Obligatorio · define el contexto físico del reporte
            </Text>

            <Text style={styles.subLabel}>Tramo</Text>
            <View style={styles.locRow}>
              {[1, 2].map((t) => (
                <Pressable
                  key={t}
                  onPress={() => {
                    setTramo(t as 1 | 2);
                    // Reset cascada si cambia
                    setEstacion(null);
                    setPoste(null);
                  }}
                  style={[styles.locChip, tramo === t && styles.locChipActive]}
                >
                  <Text style={[styles.locChipTxt, tramo === t && styles.locChipTxtActive]}>
                    Tramo {t}
                  </Text>
                </Pressable>
              ))}
            </View>

            {tramo ? (
              <>
                <Text style={[styles.subLabel, { marginTop: 10 }]}>Estación</Text>
                <View style={styles.locRow}>
                  {(tramo === 1 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9]).map((e) => (
                    <Pressable
                      key={e}
                      onPress={() => setEstacion(e)}
                      style={[styles.locChip, estacion === e && styles.locChipActive]}
                    >
                      <Text style={[styles.locChipTxt, estacion === e && styles.locChipTxtActive]}>
                        E{e}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            {tramo && estacion ? (
              <>
                <Text style={[styles.subLabel, { marginTop: 10 }]}>
                  Poste (1 - 35)
                </Text>
                <View style={styles.posteWrap}>
                  {Array.from({ length: 35 }, (_, i) => i + 1).map((p) => (
                    <Pressable
                      key={p}
                      onPress={() => setPoste(p)}
                      style={[styles.posteChip, poste === p && styles.posteChipActive]}
                    >
                      <Text style={[styles.posteChipTxt, poste === p && styles.posteChipTxtActive]}>
                        {p}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}

            {tramo && estacion && poste ? (
              <View style={styles.locSummary}>
                <Ionicons name="checkmark-circle" size={14} color="#16a34a" />
                <Text style={styles.locSummaryTxt}>
                  Tramo {tramo} · Estación {estacion} · Poste {poste}
                </Text>
              </View>
            ) : null}
          </View>

          {/* === COORDENADAS AUTO-VINCULADAS === */}
          <View style={styles.card}>
            <View style={styles.commentsHeader}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Ionicons name="navigate" size={16} color={colors.primary} />
                <Text style={styles.label}>Georreferenciación</Text>
              </View>
              {tramo && estacion && poste ? (
                <View style={styles.autoBadge}>
                  <Ionicons name="link" size={11} color="#065F46" />
                  <Text style={styles.autoBadgeTxt}>Auto</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.subLabel, { marginBottom: 8 }]}>
              Coordenadas vinculadas automáticamente al poste seleccionado
            </Text>

            <View style={styles.rowGap}>
              <View style={{ flex: 1 }}>
                <Text style={styles.subLabel}>Ubicación</Text>
                <TextInput
                  value={locationName}
                  editable={false}
                  placeholder="Selecciona Tramo / Estación / Poste"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.inputDisabled]}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.subLabel}>Coordenadas</Text>
                <TextInput
                  value={coordinates}
                  editable={false}
                  placeholder="—"
                  placeholderTextColor={colors.textMuted}
                  style={[styles.input, styles.inputDisabled]}
                />
              </View>
            </View>
          </View>

          {/* === READINGS & PROGRESS === */}
          <View style={styles.card}>
            <View style={styles.commentsHeader}>
              <Text style={styles.label}>Lecturas y avance</Text>
              <Pressable
                onPress={() => {
                  setNoAplicaLecturas((v) => !v);
                  void Haptics.selectionAsync();
                }}
                style={[styles.naToggle, noAplicaLecturas && styles.naToggleActive]}
              >
                <Ionicons
                  name={noAplicaLecturas ? 'checkbox' : 'square-outline'}
                  size={16}
                  color={noAplicaLecturas ? '#fff' : colors.textBody}
                />
                <Text style={[styles.naToggleTxt, noAplicaLecturas && { color: '#fff' }]}>
                  No aplica
                </Text>
              </Pressable>
            </View>

            {noAplicaLecturas ? (
              <View style={styles.naHint}>
                <Ionicons name="information-circle-outline" size={16} color={colors.textMuted} />
                <Text style={styles.naHintTxt}>
                  Esta sección no se incluirá en el reporte.
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.rowGap}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.subLabel}>Primera lectura</Text>
                    <TextInput
                      value={firstReading}
                      onChangeText={setFirstReading}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      keyboardType="decimal-pad"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.subLabel}>Última lectura</Text>
                    <TextInput
                      value={lastReading}
                      onChangeText={setLastReading}
                      placeholder="0.00"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      keyboardType="decimal-pad"
                    />
                  </View>
                </View>

                <Text style={[styles.subLabel, { marginTop: 8 }]}>Unidad</Text>
                <View style={styles.unitRow}>
                  {UNITS.map((u) => (
                    <Pressable
                      key={u.value}
                      onPress={() => setUnit(u.value)}
                      style={[styles.unitChip, unit === u.value && styles.unitChipActive]}
                    >
                      <Text style={[styles.unitChipTxt, unit === u.value && styles.unitChipTxtActive]}>
                        {u.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>

                <View style={styles.progressBox}>
                  <Ionicons name="trending-up" size={18} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.progressLabel}>Avance calculado</Text>
                    <Text style={styles.progressValue}>
                      {progress !== null
                        ? `${progress} ${unit !== 'none' ? UNITS.find((x) => x.value === unit)?.label : ''}`.trim()
                        : '—'}
                    </Text>
                  </View>
                </View>
              </>
            )}
          </View>

          {/* === ACTIVITIES === */}
          <View style={styles.card}>
            <Text style={styles.label}>Actividades realizadas</Text>
            <TextInput
              value={activities}
              onChangeText={setActivities}
              placeholder="Describe brevemente las actividades…"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { minHeight: 72 }]}
              multiline
              textAlignVertical="top"
            />
            {histActivities.length > 0 && !activities.trim() ? (
              <View style={styles.suggestionsWrap}>
                <Text style={styles.suggestHint}>Sugerencias recientes:</Text>
                <View style={styles.suggestionsRow}>
                  {histActivities.slice(0, 4).map((s) => (
                    <Pressable
                      key={s}
                      onPress={() => setActivities(s)}
                      style={styles.suggestionChip}
                    >
                      <Text style={styles.suggestionChipTxt} numberOfLines={1}>
                        {s.length > 40 ? s.slice(0, 40) + '…' : s}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : null}
          </View>

          {/* === PERSONNEL === */}
          <ChipMultiInput
            label="Personal"
            icon="people"
            placeholder="Ej. Juan Pérez"
            draft={personnelDraft}
            setDraft={setPersonnelDraft}
            items={personnel}
            onAdd={() => addPersonnel()}
            onRemove={removePersonnel}
            suggestions={personnelSuggestions}
            onPickSuggestion={(s) => addPersonnel(s)}
          />

          {/* === EQUIPMENT === */}
          <ChipMultiInput
            label="Equipos"
            icon="construct"
            placeholder="Ej. Retroexcavadora CAT"
            draft={equipmentDraft}
            setDraft={setEquipmentDraft}
            items={equipment}
            onAdd={() => addEquipment()}
            onRemove={removeEquipment}
            suggestions={equipmentSuggestions}
            onPickSuggestion={(s) => addEquipment(s)}
          />

          {/* === TITLE === */}
          <View style={styles.card}>
            <Text style={styles.label}>Título</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Ej. Colado de losa nivel 3"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              maxLength={100}
            />
          </View>

          {/* === COMMENTS w/ AI === */}
          <View style={styles.card}>
            <View style={styles.commentsHeader}>
              <Text style={styles.label}>Comentarios y observaciones</Text>
              <Pressable onPress={improveWithAI} disabled={aiLoading} style={styles.aiBtn}>
                {aiLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="sparkles" size={14} color="#fff" />
                    <Text style={styles.aiBtnText}>Mejorar con IA</Text>
                  </>
                )}
              </Pressable>
            </View>
            <TextInput
              value={comments}
              onChangeText={setComments}
              placeholder="Describe avances, incidencias, materiales…"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.textarea]}
              multiline
              textAlignVertical="top"
            />
          </View>

          {/* === PRIORITY === */}
          <View style={styles.card}>
            <Text style={styles.label}>Prioridad</Text>
            <View style={styles.priorityRow}>
              {PRIORITIES.map((p) => (
                <Pressable
                  key={p.value}
                  onPress={() => {
                    setPriority(p.value);
                    void Haptics.selectionAsync();
                  }}
                  style={[
                    styles.priorityChip,
                    {
                      backgroundColor: priority === p.value ? p.bg : colors.bg,
                      borderColor: priority === p.value ? p.color : colors.border,
                    },
                  ]}
                >
                  <Ionicons name={p.icon} size={14} color={priority === p.value ? p.color : colors.textMuted} />
                  <Text
                    style={[
                      styles.priorityTxt,
                      { color: priority === p.value ? p.color : colors.textMuted },
                    ]}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* === PHOTOS === */}
          <View style={styles.card}>
            <View style={styles.photosHeader}>
              <Text style={styles.label}>Evidencia fotográfica</Text>
              <Text style={styles.muted}>{images.length}/20</Text>
            </View>
            <View style={styles.photoActions}>
              <Pressable onPress={takePhoto} style={styles.actionBtn}>
                <Ionicons name="camera" size={20} color={colors.primary} />
                <Text style={styles.actionTxt}>Cámara</Text>
              </Pressable>
              <Pressable onPress={pickFromGallery} style={styles.actionBtn}>
                <Ionicons name="images" size={20} color={colors.primary} />
                <Text style={styles.actionTxt}>Galería</Text>
              </Pressable>
            </View>
            {images.length > 0 ? (
              <View style={styles.grid}>
                {images.map((uri, i) => (
                  <View key={i} style={styles.thumbWrap}>
                    <Image source={{ uri }} style={styles.thumb} />
                    <Pressable onPress={() => removeImage(i)} style={styles.removeBtn} hitSlop={6}>
                      <Ionicons name="close" size={14} color="#fff" />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.emptyPhotos}>
                <Ionicons name="image-outline" size={28} color={colors.textMuted} />
                <Text style={styles.muted}>Agrega fotos del avance</Text>
              </View>
            )}
          </View>

          {/* === ARCHIVOS ADJUNTOS === */}
          <View style={styles.card}>
            <View style={styles.photosHeader}>
              <Text style={styles.label}>Archivos adjuntos</Text>
              <Text style={styles.muted}>{files.length}/5</Text>
            </View>
            <Text style={[styles.muted, { marginBottom: 6 }]}>
              PDF, Excel, Word, CSV o escaneo de cámara. Máximo 8 MB c/u.
            </Text>
            <View style={styles.photoActions}>
              <Pressable onPress={pickDocument} style={styles.actionBtn}>
                <Ionicons name="folder-open" size={20} color={colors.primary} />
                <Text style={styles.actionTxt}>Subir archivo</Text>
              </Pressable>
              <Pressable onPress={scanDocument} style={styles.actionBtn}>
                <Ionicons name="scan" size={20} color={colors.primary} />
                <Text style={styles.actionTxt}>Escanear</Text>
              </Pressable>
            </View>
            {files.length > 0 ? (
              <View style={{ gap: 6, marginTop: 8 }}>
                {files.map((f, i) => (
                  <View key={i} style={styles.fileRow}>
                    <Ionicons
                      name={fileKindIcon(f.mimeType) as any}
                      size={20}
                      color={colors.primary}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fileName} numberOfLines={1}>{f.name}</Text>
                      <Text style={styles.fileMeta} numberOfLines={1}>
                        {f.mimeType}{f.size ? `  ${fmtBytes(f.size)}` : ''}
                      </Text>
                    </View>
                    <Pressable onPress={() => removeFile(i)} hitSlop={8} style={styles.fileRemove}>
                      <Ionicons name="trash" size={16} color="#B91C1C" />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          {!online ? (
            <View style={styles.offlineHint}>
              <Ionicons name="cloud-offline" size={16} color="#92400E" />
              <Text style={styles.offlineText}>Sin conexión — el reporte se guardará y enviará después.</Text>
            </View>
          ) : null}

          <Button
            label={online ? 'Enviar reporte' : 'Guardar localmente'}
            icon={<Ionicons name={online ? 'send' : 'save'} size={16} color="#fff" />}
            onPress={submit}
            loading={submitting}
            fullWidth
            style={{ marginTop: spacing.sm }}
          />
        </ScrollView>
      </KeyboardAvoidingView>

      {/* === Reference Point Picker Modal === */}
      <Modal
        visible={pointPickerOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setPointPickerOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalSheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Selecciona un punto</Text>
              <Pressable onPress={() => setPointPickerOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            {sortedRefPoints.length === 0 ? (
              <View style={{ padding: spacing.lg, alignItems: 'center' }}>
                <Ionicons name="location-outline" size={32} color={colors.textMuted} />
                <Text style={[styles.muted, { textAlign: 'center', marginTop: 8 }]}>
                  Aún no hay puntos de referencia.{'\n'}Crea uno con el botón «Nuevo».
                </Text>
              </View>
            ) : (
              <FlatList
                data={sortedRefPoints}
                keyExtractor={(item) => item.id}
                ItemSeparatorComponent={() => <View style={styles.sep} />}
                style={{ maxHeight: 380 }}
                renderItem={({ item }) => (
                  <Pressable onPress={() => selectPoint(item)} style={styles.pointRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pointName}>{item.name}</Text>
                      <Text style={styles.pointMeta} numberOfLines={1}>
                        {[item.location, item.coordinates].filter(Boolean).join(' • ') || '—'}
                      </Text>
                    </View>
                    {!item.area ? (
                      <View style={styles.globalBadge}>
                        <Text style={styles.globalBadgeTxt}>Global</Text>
                      </View>
                    ) : null}
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                  </Pressable>
                )}
              />
            )}
            <Pressable
              onPress={() => {
                setPointPickerOpen(false);
                setNewPointModalOpen(true);
              }}
              style={styles.newInModalBtn}
            >
              <Ionicons name="add-circle" size={20} color={colors.primary} />
              <Text style={styles.newInModalTxt}>Crear nuevo punto</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* === New Reference Point Modal === */}
      <Modal
        visible={newPointModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setNewPointModalOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalDialog}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Nuevo punto de referencia</Text>
              <Pressable onPress={() => setNewPointModalOpen(false)} hitSlop={8}>
                <Ionicons name="close" size={22} color={colors.text} />
              </Pressable>
            </View>
            <Text style={styles.subLabel}>Nombre</Text>
            <TextInput
              value={newPointName}
              onChangeText={setNewPointName}
              placeholder="Ej. Poste 12"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoFocus
            />
            <Text style={[styles.subLabel, { marginTop: 8 }]}>Ubicación (opcional)</Text>
            <TextInput
              value={newPointLocation}
              onChangeText={setNewPointLocation}
              placeholder="Ej. Tramo Norte"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
            <Text style={[styles.subLabel, { marginTop: 8 }]}>Coordenadas (opcional)</Text>
            <TextInput
              value={newPointCoords}
              onChangeText={setNewPointCoords}
              placeholder="19.43°N, 99.13°W"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoCapitalize="none"
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setNewPointModalOpen(false)}
                style={[styles.modalBtn, styles.modalBtnGhost]}
              >
                <Text style={styles.modalBtnGhostTxt}>Cancelar</Text>
              </Pressable>
              <Pressable
                onPress={createNewPoint}
                disabled={creatingPoint}
                style={[styles.modalBtn, styles.modalBtnPrimary]}
              >
                {creatingPoint ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.modalBtnPrimaryTxt}>Crear</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {/* === Sello anti-fraude (cámara) === */}
      <StampedPhotoModal
        visible={!!pendingStampBase64}
        base64={pendingStampBase64}
        onCancel={() => setPendingStampBase64(null)}
        onConfirm={(stamped) => {
          setPendingStampBase64(null);
          setImages((prev) => [...prev, stamped].slice(0, 20));
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }}
      />
    </View>
  );
}

function HeaderRow({
  icon,
  label,
  value,
  muted,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <View style={styles.headerRow}>
      <Ionicons name={icon} size={14} color={colors.textMuted} />
      <Text style={styles.headerRowLabel}>{label}</Text>
      <Text style={[styles.headerRowValue, muted && { color: colors.textMuted, fontStyle: 'italic' }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

interface ChipMultiInputProps {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  placeholder: string;
  draft: string;
  setDraft: (v: string) => void;
  items: string[];
  onAdd: () => void;
  onRemove: (item: string) => void;
  suggestions: string[];
  onPickSuggestion: (s: string) => void;
}

function ChipMultiInput({
  label,
  icon,
  placeholder,
  draft,
  setDraft,
  items,
  onAdd,
  onRemove,
  suggestions,
  onPickSuggestion,
}: ChipMultiInputProps) {
  return (
    <View style={styles.card}>
      <View style={styles.commentsHeader}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Ionicons name={icon} size={16} color={colors.primary} />
          <Text style={styles.label}>{label}</Text>
        </View>
        <Text style={styles.muted}>{items.length}</Text>
      </View>

      <View style={styles.inlineRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={onAdd}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { flex: 1 }]}
          returnKeyType="done"
        />
        <Pressable onPress={onAdd} style={styles.addChipBtn}>
          <Ionicons name="add" size={20} color="#fff" />
        </Pressable>
      </View>

      {suggestions.length > 0 ? (
        <View style={styles.suggestionsWrap}>
          <Text style={styles.suggestHint}>Sugerencias del área:</Text>
          <View style={styles.suggestionsRow}>
            {suggestions.map((s) => (
              <Pressable
                key={s}
                onPress={() => onPickSuggestion(s)}
                style={styles.suggestionChip}
              >
                <Ionicons name="add" size={12} color={colors.primary} />
                <Text style={styles.suggestionChipTxt}>{s}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {items.length > 0 ? (
        <View style={[styles.chipsRow, { marginTop: 8 }]}>
          {items.map((it) => (
            <View key={it} style={styles.chip}>
              <Text style={styles.chipTxt}>{it}</Text>
              <Pressable onPress={() => onRemove(it)} hitSlop={6}>
                <Ionicons name="close" size={14} color={colors.primary} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ============================================================
// Styles
// ============================================================
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

  // Header card
  headerCard: { backgroundColor: '#F1F5FF', borderColor: '#C7D2FE' },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  headerTitle: { fontSize: 13, fontWeight: '800', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.4 },
  locRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  locChip: {
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  locChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  locChipTxt: { fontSize: 13, fontWeight: '800', color: colors.textBody },
  locChipTxtActive: { color: '#fff' },
  posteWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginTop: 6 },
  posteChip: {
    minWidth: 38, height: 36, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 8, borderRadius: 8,
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border,
  },
  posteChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  posteChipTxt: { fontSize: 12, fontWeight: '800', color: colors.textBody },
  posteChipTxtActive: { color: '#fff' },
  fileRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 10, paddingVertical: 9,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  fileName: { fontSize: 13, fontWeight: '700', color: colors.text },
  fileMeta: { fontSize: 11, color: colors.textMuted, marginTop: 1 },
  fileRemove: {
    width: 30, height: 30, alignItems: 'center', justifyContent: 'center',
    borderRadius: 6, backgroundColor: '#FEE2E2',
  },
  locSummary: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, padding: 8, borderRadius: 6,
    backgroundColor: '#ECFDF5', borderWidth: 1, borderColor: '#A7F3D0',
  },
  locSummaryTxt: { fontSize: 12, fontWeight: '700', color: '#065F46' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  headerRowLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '700', width: 90 },
  headerRowValue: { fontSize: 13, color: colors.text, fontWeight: '600', flex: 1 },

  // Labels / inputs
  label: { fontSize: 13, fontWeight: '800', color: colors.text, marginBottom: 8 },
  subLabel: { fontSize: 12, fontWeight: '700', color: colors.textMuted, marginBottom: 4 },
  muted: { fontSize: 12, color: colors.textMuted, fontWeight: '700' },
  input: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 8,
    fontSize: 15,
    color: colors.text,
  },
  textarea: { minHeight: 120 },
  rowGap: { flexDirection: 'row', gap: spacing.sm, marginTop: 8 },
  inputDisabled: {
    backgroundColor: '#F1F5F9',
    color: colors.textBody,
    borderColor: '#E2E8F0',
  },
  autoBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: '#D1FAE5',
    borderWidth: 1,
    borderColor: '#A7F3D0',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  autoBadgeTxt: { fontSize: 10, fontWeight: '800', color: '#065F46', textTransform: 'uppercase', letterSpacing: 0.3 },

  // Reference point picker
  commentsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  smallPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primary,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  smallPrimaryBtnTxt: { color: '#fff', fontWeight: '800', fontSize: 11 },
  pickerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  pickerTxt: { flex: 1, fontSize: 15, color: colors.text, fontWeight: '600' },

  // Units & priority chips
  naToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999, borderWidth: 1, borderColor: colors.borderStrong,
    backgroundColor: colors.bg,
  },
  naToggleActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  naToggleTxt: { fontSize: 12, fontWeight: '800', color: colors.textBody },
  naHint: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, padding: 10, marginTop: 4,
  },
  naHintTxt: { color: colors.textMuted, fontSize: 12, fontStyle: 'italic', flex: 1 },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  unitChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 44,
    alignItems: 'center',
  },
  unitChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  unitChipTxt: { fontSize: 12, fontWeight: '800', color: colors.textBody },
  unitChipTxtActive: { color: '#fff' },

  // Progress display
  progressBox: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
  },
  progressLabel: { fontSize: 11, fontWeight: '700', color: colors.primary, textTransform: 'uppercase' },
  progressValue: { fontSize: 18, fontWeight: '800', color: colors.primaryDark, marginTop: 2 },

  // Suggestions
  suggestionsWrap: { marginTop: 8 },
  suggestHint: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginBottom: 6 },
  suggestionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  suggestionChipTxt: { fontSize: 12, color: colors.primary, fontWeight: '700' },

  // Chip multi-input
  inlineRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  addChipBtn: {
    backgroundColor: colors.primary,
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  chipTxt: { fontSize: 13, color: colors.primary, fontWeight: '700' },

  // Priority
  priorityRow: { flexDirection: 'row', gap: 6 },
  priorityChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  priorityTxt: { fontSize: 12, fontWeight: '800' },

  // AI button (existing style)
  aiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#0F172A',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  aiBtnText: { color: '#fff', fontWeight: '800', fontSize: 11 },

  // Photos
  photosHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  photoActions: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
    paddingVertical: 12,
  },
  actionTxt: { color: colors.primary, fontWeight: '800', fontSize: 13 },
  emptyPhotos: { alignItems: 'center', padding: spacing.md, gap: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  thumbWrap: { width: THUMB, height: THUMB, borderRadius: radius.md, overflow: 'hidden' },
  thumb: { width: '100%', height: '100%', backgroundColor: colors.border },
  removeBtn: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Offline
  offlineHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FEF3C7',
    borderColor: '#FCD34D',
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 10,
  },
  offlineText: { color: '#92400E', fontSize: 12, fontWeight: '700', flex: 1 },

  // Modals
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  modalDialog: {
    backgroundColor: colors.surface,
    marginHorizontal: spacing.md,
    marginVertical: 'auto',
    alignSelf: 'stretch',
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: 'auto',
    marginTop: 'auto',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  modalBtnGhostTxt: { color: colors.textBody, fontWeight: '700' },
  modalBtnPrimary: { backgroundColor: colors.primary },
  modalBtnPrimaryTxt: { color: '#fff', fontWeight: '800' },

  sep: { height: 1, backgroundColor: colors.border },
  pointRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 8 },
  pointName: { fontSize: 15, fontWeight: '700', color: colors.text },
  pointMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  globalBadge: { backgroundColor: '#E0E7FF', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  globalBadgeTxt: { fontSize: 10, fontWeight: '800', color: colors.primary },
  newInModalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 12,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md,
  },
  newInModalTxt: { color: colors.primary, fontWeight: '800', fontSize: 14 },
});
