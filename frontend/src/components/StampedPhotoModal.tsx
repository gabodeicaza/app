import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Modal, View, Text, StyleSheet, Image, Pressable,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import ViewShot, { captureRef } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system/legacy';
import { buildStampMeta, type PhotoStampMeta } from '@/src/utils/photo-stamp';
import { colors, radius, spacing } from '@/src/theme';

interface Props {
  visible: boolean;
  base64: string | null;  // data URL
  onCancel: () => void;
  onConfirm: (stampedBase64: string) => void;
}

/**
 * Muestra una foto recien capturada con sello anti-fraude superpuesto
 * (GPS, fecha, hora, clima). Al confirmar se aplana foto+sello en una sola
 * imagen JPEG base64 (Cero Huella Local: no se escribe en galeria).
 */
export function StampedPhotoModal({ visible, base64, onCancel, onConfirm }: Props) {
  const insets = useSafeAreaInsets();
  const shotRef = useRef<View>(null);
  const [meta, setMeta] = useState<PhotoStampMeta | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) { setMeta(null); return; }
    let cancelled = false;
    (async () => {
      const m = await buildStampMeta();
      if (!cancelled) setMeta(m);
    })();
    return () => { cancelled = true; };
  }, [visible]);

  const confirm = useCallback(async () => {
    if (!shotRef.current || !meta) return;
    setBusy(true);
    try {
      const uri = await captureRef(shotRef as any, {
        format: 'jpg', quality: 0.85, result: 'tmpfile',
      });
      const b64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      onConfirm(`data:image/jpeg;base64,${b64}`);
    } catch (e) {
      if (base64) onConfirm(base64);
    } finally {
      setBusy(false);
    }
  }, [meta, base64, onConfirm]);

  if (!visible || !base64) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onCancel}>
      <View style={[styles.flex, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable onPress={onCancel} hitSlop={10} style={styles.iconBtn}>
            <Ionicons name="close" size={22} color={colors.text} />
          </Pressable>
          <View>
            <Text style={styles.title}>Sello anti-fraude</Text>
            <Text style={styles.subtitle}>Revisa la marca antes de adjuntar</Text>
          </View>
          <View style={{ width: 32 }} />
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.shotWrap}>
            <ViewShot ref={shotRef as any} options={{ format: 'jpg', quality: 0.85 }} style={styles.shot}>
              <Image source={{ uri: base64 }} style={styles.photo} resizeMode="cover" />
              {meta ? <StampOverlay meta={meta} /> : (
                <View style={styles.loadingOverlay}>
                  <ActivityIndicator color="#fff" />
                </View>
              )}
            </ViewShot>
          </View>

          <View style={styles.hint}>
            <Ionicons name="shield-checkmark" size={16} color={colors.primary} />
            <Text style={styles.hintTxt}>
              La marca se incrusta en la imagen final. Sin GPS se mostrara &quot;Sin GPS&quot;.
            </Text>
          </View>
        </ScrollView>

        <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable onPress={onCancel} style={[styles.btn, styles.btnGhost]}>
            <Text style={styles.btnGhostTxt}>Descartar</Text>
          </Pressable>
          <Pressable
            onPress={confirm}
            disabled={!meta || busy}
            style={[styles.btn, styles.btnPrimary, (!meta || busy) && { opacity: 0.6 }]}
          >
            {busy
              ? <ActivityIndicator color="#fff" />
              : <>
                  <Ionicons name="checkmark" size={16} color="#fff" />
                  <Text style={styles.btnPrimaryTxt}>Usar foto con sello</Text>
                </>
            }
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function StampOverlay({ meta }: { meta: PhotoStampMeta }) {
  return (
    <View style={styles.stampOverlay} pointerEvents="none">
      <View style={styles.stampTopRight}>
        <Text style={styles.stampApp}>{meta.app}</Text>
      </View>
      <View style={styles.stampBottom}>
        <View style={styles.stampLine}>
          <Ionicons name="location" size={11} color="#fff" />
          <Text style={styles.stampTxt}>{meta.coordinates}</Text>
        </View>
        <View style={styles.stampLine}>
          <Ionicons name="calendar" size={11} color="#fff" />
          <Text style={styles.stampTxt}>{meta.date}  {meta.time}</Text>
        </View>
        <View style={styles.stampLine}>
          <Ionicons name="partly-sunny" size={11} color="#fff" />
          <Text style={styles.stampTxt}>{meta.weather}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingBottom: spacing.sm + 2,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface,
  },
  iconBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '900', color: colors.text, textAlign: 'center' },
  subtitle: { fontSize: 11, color: colors.textMuted, textAlign: 'center', marginTop: 2 },
  body: { padding: spacing.md, gap: spacing.md, alignItems: 'center' },
  shotWrap: {
    width: '100%', aspectRatio: 3 / 4, maxHeight: 540,
    backgroundColor: '#000', borderRadius: radius.md, overflow: 'hidden',
  },
  shot: { width: '100%', height: '100%', position: 'relative' },
  photo: { width: '100%', height: '100%' },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  stampOverlay: { ...StyleSheet.absoluteFillObject },
  stampTopRight: {
    position: 'absolute', top: 10, right: 10,
    backgroundColor: 'rgba(15,23,42,0.7)',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6,
  },
  stampApp: { color: '#fff', fontSize: 11, fontWeight: '900', letterSpacing: 0.5 },
  stampBottom: {
    position: 'absolute', left: 10, right: 10, bottom: 10,
    backgroundColor: 'rgba(15,23,42,0.78)',
    padding: 10, borderRadius: 8, gap: 4,
  },
  stampLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stampTxt: { color: '#fff', fontSize: 11, fontWeight: '700', flexShrink: 1 },
  hint: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.primaryLight, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, alignSelf: 'stretch',
  },
  hintTxt: { flex: 1, color: colors.textBody, fontSize: 12, lineHeight: 16 },
  footer: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: spacing.md, paddingTop: spacing.sm,
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  btn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 13, borderRadius: radius.md },
  btnGhost: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  btnGhostTxt: { color: colors.textBody, fontWeight: '800', fontSize: 14 },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryTxt: { color: '#fff', fontWeight: '900', fontSize: 14 },
});
