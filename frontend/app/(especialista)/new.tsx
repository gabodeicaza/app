import React, { useEffect, useState } from 'react';
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { useSync } from '@/src/sync-context';
import { colors, radius, spacing } from '@/src/theme';

const { width } = Dimensions.get('window');
const THUMB = (width - spacing.md * 2 - spacing.sm * 2) / 3;

export default function NewReport() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { online, enqueue, syncNow } = useSync();
  const [title, setTitle] = useState('');
  const [comments, setComments] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [areaName, setAreaName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const areas = await api.listAreas();
        const a = areas.find((x: any) => x.id === user?.area);
        if (a) setAreaName(a.name);
      } catch {}
    })();
  }, [user?.area]);

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
          ...(canAsk ? [] : [{ text: 'Abrir Ajustes', onPress: () => import('react-native').then((rn) => rn.Linking.openSettings()) }]),
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
    const items = result.assets
      .map((a) => (a.base64 ? `data:image/jpeg;base64,${a.base64}` : a.uri))
      .filter(Boolean);
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
          ...(canAsk ? [] : [{ text: 'Abrir Ajustes', onPress: () => import('react-native').then((rn) => rn.Linking.openSettings()) }]),
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
    const item = asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : asset.uri;
    setImages((prev) => [...prev, item].slice(0, 20));
    void Haptics.selectionAsync();
  }

  function removeImage(i: number) {
    setImages((prev) => prev.filter((_, idx) => idx !== i));
  }

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

  async function submit() {
    if (!title.trim()) {
      Alert.alert('Título requerido', 'Escribe un título corto del reporte.');
      return;
    }
    if (!user?.area) {
      Alert.alert('Sin área', 'Tu cuenta no tiene un área asignada.');
      return;
    }
    setSubmitting(true);
    try {
      if (online) {
        await api.createReport({
          title: title.trim(),
          comments: comments.trim(),
          area: user.area,
          images,
        });
      } else {
        await enqueue({
          title: title.trim(),
          comments: comments.trim(),
          area: user.area,
          areaName,
          images,
        });
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        online ? 'Reporte enviado' : 'Guardado localmente',
        online ? 'Tu reporte se sincronizó.' : 'Se enviará automáticamente al recuperar conexión.',
      );
      setTitle('');
      setComments('');
      setImages([]);
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
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        >
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
              placeholder="Describe avances, incidencias, materiales, personal..."
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.textarea]}
              multiline
              textAlignVertical="top"
            />
          </View>

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
  label: { fontSize: 13, fontWeight: '800', color: colors.text, marginBottom: 8 },
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
  commentsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
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
});
