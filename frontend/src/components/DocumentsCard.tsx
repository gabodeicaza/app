// DocumentsCard.tsx - Repositorio compartido de Documentos Clave.
// CERO HUELLA LOCAL: Los archivos se procesan como Base64 en RAM y se eliminan
// inmediatamente del cache. Los uploads se hacen vía expo-document-picker, se leen
// con FileSystem.readAsStringAsync y el archivo temporal se borra justo después.
// La descarga/preview también guarda el archivo en un dir temporal y se borra a los
// 20s. Roles autorizados a SUBIR/ELIMINAR: Coordinador Global + Supervisores.
// Resto (especialistas, contratistas, dependencias) son SOLO LECTURA.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { canManageDocuments } from '@/src/utils/roles';
import { colors, radius, spacing } from '@/src/theme';

interface DocItem {
  id: string;
  title: string;
  description?: string | null;
  mime_type: string;
  filename: string;
  size_kb: number;
  uploaded_by_name: string;
  uploaded_at: string;
}

function iconForMime(mime: string): any {
  if (mime?.startsWith('image/')) return 'image-outline';
  if (mime === 'application/pdf') return 'document-text-outline';
  if (mime?.includes('word')) return 'document-outline';
  if (mime?.includes('sheet') || mime?.includes('excel')) return 'grid-outline';
  return 'document-attach-outline';
}

function fmtDate(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function DocumentsCard() {
  const { user } = useAuth();
  const canManage = canManageDocuments(user?.role);
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Modal de metadata para subida
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingPick, setPendingPick] = useState<{ uri: string; mime: string; name: string } | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.listDocuments();
      setDocs(data || []);
    } catch {
      // mantener cache
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // CERO HUELLA LOCAL: pick → read base64 → delete cache temp inmediatamente.
  const onPick = useCallback(async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: '*/*',
      });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      setPendingPick({
        uri: a.uri,
        mime: a.mimeType || 'application/octet-stream',
        name: a.name || 'archivo',
      });
      setTitle((a.name || '').replace(/\.[^.]+$/, ''));
      setDescription('');
      setModalOpen(true);
    } catch (e: any) {
      Alert.alert('No se pudo seleccionar', e?.message || 'Intenta de nuevo.');
    }
  }, []);

  const onConfirmUpload = useCallback(async () => {
    if (!pendingPick) return;
    if (!title.trim()) {
      Alert.alert('Falta título', 'Ponle un título descriptivo al documento.');
      return;
    }
    setUploading(true);
    let base64: string | null = null;
    try {
      base64 = await FileSystem.readAsStringAsync(pendingPick.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await api.uploadDocument({
        title: title.trim(),
        description: description.trim() || undefined,
        mime_type: pendingPick.mime,
        filename: pendingPick.name,
        data_base64: base64,
      });
      // Limpiar RAM (variable) y disco (cache temporal).
      base64 = null;
      await FileSystem.deleteAsync(pendingPick.uri, { idempotent: true }).catch(() => {});
      setModalOpen(false);
      setPendingPick(null);
      setTitle('');
      setDescription('');
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo subir', e?.message || 'Intenta de nuevo.');
    } finally {
      base64 = null; // garantiza GC
      setUploading(false);
    }
  }, [pendingPick, title, description, load]);

  const onCancelUpload = useCallback(async () => {
    // Borrar cache si el usuario canceló el flujo después del picker.
    if (pendingPick) {
      await FileSystem.deleteAsync(pendingPick.uri, { idempotent: true }).catch(() => {});
    }
    setPendingPick(null);
    setTitle('');
    setDescription('');
    setModalOpen(false);
  }, [pendingPick]);

  // CERO HUELLA LOCAL: descargar base64, escribir temp, compartir, borrar a los 20s.
  const onOpen = useCallback(async (doc: DocItem) => {
    setBusyId(doc.id);
    let payload: any = null;
    try {
      payload = await api.getDocument(doc.id);
      const safeName = (payload.filename || doc.filename || 'documento').replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmp = `${FileSystem.cacheDirectory}synco_tmp_${Date.now()}_${safeName}`;
      await FileSystem.writeAsStringAsync(tmp, payload.data_base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Liberar RAM antes de compartir.
      payload.data_base64 = null;
      payload = null;
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(tmp, {
          mimeType: doc.mime_type,
          dialogTitle: doc.title,
          UTI: doc.mime_type === 'application/pdf' ? 'com.adobe.pdf' : undefined,
        });
      } else {
        Alert.alert('Compartir no disponible', 'No se puede abrir el documento en este dispositivo.');
      }
      setTimeout(() => {
        FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      }, 20000);
    } catch (e: any) {
      Alert.alert('No se pudo abrir', e?.message || 'Intenta de nuevo.');
    } finally {
      payload = null;
      setBusyId(null);
    }
  }, []);

  const onDelete = useCallback(
    (doc: DocItem) => {
      Alert.alert(
        'Eliminar documento',
        `¿Eliminar "${doc.title}" del repositorio compartido? Esta acción no se puede deshacer.`,
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Eliminar',
            style: 'destructive',
            onPress: async () => {
              setBusyId(doc.id);
              try {
                await api.deleteDocument(doc.id);
                await load();
              } catch (e: any) {
                Alert.alert('No se pudo eliminar', e?.message || 'Intenta de nuevo.');
              } finally {
                setBusyId(null);
              }
            },
          },
        ],
      );
    },
    [load],
  );

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>Documentos clave</Text>
          <Text style={styles.cardSub}>
            {canManage
              ? 'Repositorio compartido · Cero huella local'
              : 'Repositorio compartido · Solo lectura'}
          </Text>
        </View>
        {canManage ? (
          <Pressable
            onPress={onPick}
            disabled={uploading}
            style={[styles.uploadBtn, uploading && { opacity: 0.6 }]}
            hitSlop={6}
          >
            {uploading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={14} color="#fff" />
                <Text style={styles.uploadBtnText}>Subir</Text>
              </>
            )}
          </Pressable>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : docs.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="folder-open-outline" size={28} color={colors.textMuted} />
          <Text style={styles.emptyTxt}>
            {canManage
              ? 'Aún no hay documentos. Súbelos para todo el equipo.'
              : 'Aún no hay documentos compartidos.'}
          </Text>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {docs.map((d) => (
            <Pressable
              key={d.id}
              onPress={() => onOpen(d)}
              disabled={busyId === d.id}
              style={({ pressed }) => [
                styles.docRow,
                pressed && { opacity: 0.85 },
              ]}
            >
              <View style={styles.docIcon}>
                <Ionicons name={iconForMime(d.mime_type)} size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={styles.docTitle}>
                  {d.title}
                </Text>
                <Text numberOfLines={1} style={styles.docMeta}>
                  {d.uploaded_by_name} · {fmtDate(d.uploaded_at)} · {Math.max(1, Math.round(d.size_kb))} KB
                </Text>
              </View>
              {busyId === d.id ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : canManage ? (
                <Pressable onPress={() => onDelete(d)} hitSlop={8} style={styles.delBtn}>
                  <Ionicons name="trash-outline" size={16} color={colors.error} />
                </Pressable>
              ) : (
                <Ionicons name="download-outline" size={18} color={colors.textMuted} />
              )}
            </Pressable>
          ))}
        </View>
      )}

      <Modal
        visible={modalOpen}
        transparent
        animationType="fade"
        onRequestClose={onCancelUpload}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Subir documento</Text>
            <Text style={styles.modalSub}>
              Se procesa en memoria y se sube al repositorio. No queda copia local.
            </Text>
            <Text style={styles.label}>Título</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder="Ej. Procedimiento de soldadura V2"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
            <Text style={styles.label}>Descripción (opcional)</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Notas o contexto del documento"
              placeholderTextColor={colors.textMuted}
              multiline
              style={[styles.input, { minHeight: 70, textAlignVertical: 'top' }]}
            />
            {pendingPick ? (
              <View style={styles.pickInfo}>
                <Ionicons name={iconForMime(pendingPick.mime)} size={16} color={colors.primary} />
                <Text style={styles.pickInfoTxt} numberOfLines={1}>
                  {pendingPick.name}
                </Text>
              </View>
            ) : null}
            <View style={styles.modalActions}>
              <Pressable onPress={onCancelUpload} style={[styles.modalBtn, styles.modalBtnGhost]}>
                <Text style={styles.modalBtnGhostTxt}>Cancelar</Text>
              </Pressable>
              <Pressable
                onPress={onConfirmUpload}
                disabled={uploading}
                style={[styles.modalBtn, styles.modalBtnPrimary, uploading && { opacity: 0.6 }]}
              >
                {uploading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.modalBtnPrimaryTxt}>Subir</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  cardTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
  cardSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontWeight: '600' },
  uploadBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  uploadBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  center: { padding: spacing.md, alignItems: 'center' },
  empty: { alignItems: 'center', padding: spacing.md, gap: 6 },
  emptyTxt: { color: colors.textMuted, fontSize: 12, textAlign: 'center' },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.sm + 2,
    backgroundColor: colors.bg,
  },
  docIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docTitle: { fontSize: 13, fontWeight: '800', color: colors.text },
  docMeta: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  delBtn: { padding: 6 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
  },
  modalCard: {
    width: '100%',
    maxWidth: 480,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: 8,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 8 },
      default: {},
    }),
  },
  modalTitle: { fontSize: 16, fontWeight: '900', color: colors.text },
  modalSub: { fontSize: 12, color: colors.textMuted, marginBottom: spacing.sm },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginTop: 8, marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.text,
  },
  pickInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.primaryLight,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  pickInfoTxt: { color: colors.primary, fontWeight: '700', fontSize: 12, flex: 1 },
  modalActions: { flexDirection: 'row', gap: 8, marginTop: spacing.md },
  modalBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalBtnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  modalBtnGhostTxt: { color: colors.textBody, fontWeight: '800', fontSize: 13 },
  modalBtnPrimary: { backgroundColor: colors.primary },
  modalBtnPrimaryTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
