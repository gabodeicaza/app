/**
 * DebugNetworkModal.tsx — Escape hatch de red (2026-07-06).
 *
 * Modal accesible desde la pantalla de Login que permite al operador
 * ingresar MANUALMENTE la URL del backend cuando la comunicación via
 * `EXPO_PUBLIC_BACKEND_URL` falla en el dispositivo físico (Expo Go,
 * DNS interno, proxy roto, etc.).
 *
 * Uso típico:
 *   <DebugNetworkModal visible={open} onClose={() => setOpen(false)} />
 *
 * Al guardar, la URL se persiste en AsyncStorage bajo la clave
 * `debug_backend_url` y se aplica INMEDIATAMENTE al binding `BASE`
 * exportado desde `src/api.ts` (live-binding). Toda petición posterior
 * pega en la nueva URL.
 */
import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  BASE,
  getCurrentBase,
  getStoredDebugBase,
  setDebugBase,
} from '@/src/api';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function DebugNetworkModal({ visible, onClose }: Props) {
  const [manualUrl, setManualUrl] = useState('');
  const [storedUrl, setStoredUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setTestResult(null);
    getStoredDebugBase()
      .then((v) => {
        setStoredUrl(v);
        setManualUrl(v || '');
      })
      .catch(() => setStoredUrl(null));
  }, [visible]);

  async function onSave() {
    if (!manualUrl.trim()) {
      Alert.alert(
        'Falta la URL',
        'Escribe algo como http://192.168.1.42:8001 o pulsa "Restablecer" para volver al valor por defecto.',
      );
      return;
    }
    setSaving(true);
    try {
      const newBase = await setDebugBase(manualUrl);
      Alert.alert(
        'URL de backend actualizada',
        `Nueva URL activa:\n\n${newBase}\n\nLa próxima llamada pegará ahí.`,
      );
      setStoredUrl(manualUrl.trim());
    } catch (e: any) {
      Alert.alert('No se pudo guardar', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function onReset() {
    setSaving(true);
    try {
      const newBase = await setDebugBase(null);
      Alert.alert(
        'URL restablecida',
        `Se restauró la URL por defecto:\n\n${newBase}`,
      );
      setStoredUrl(null);
      setManualUrl('');
    } catch (e: any) {
      Alert.alert('No se pudo restablecer', String(e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setTesting(true);
    setTestResult(null);
    const target = `${getCurrentBase()}/health`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(target, { method: 'GET', signal: ctrl.signal });
      clearTimeout(t);
      const body = await res.text();
      setTestResult(
        `HTTP ${res.status} — ${target}\n\nBody (${body.length} bytes):\n${body.slice(0, 400)}`,
      );
    } catch (e: any) {
      // Volcado del error COMPLETO — incluye TypeError/NetworkError/AbortError.
      const detail = JSON.stringify(e, Object.getOwnPropertyNames(e), 2);
      setTestResult(`❌ FALLÓ ${target}\n\n${detail}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Ionicons name="bug-outline" size={22} color="#7C3AED" />
            <Text style={styles.title}>Debug de red</Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color="#64748B" />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={{ paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={styles.help}>
              Fuerza manualmente la URL del backend cuando la app no
              logre comunicarse desde tu dispositivo físico. Ejemplo:
            </Text>
            <Text style={styles.example}>http://192.168.1.42:8001</Text>

            <Text style={styles.label}>URL manual</Text>
            <TextInput
              value={manualUrl}
              onChangeText={setManualUrl}
              placeholder="http://192.168.1.XX:8001"
              placeholderTextColor="#94A3B8"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
              style={styles.input}
              editable={!saving && !testing}
            />

            <View style={styles.row}>
              <Pressable
                style={[styles.btn, styles.btnPrimary, (saving || testing) && styles.btnDisabled]}
                onPress={onSave}
                disabled={saving || testing}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <Ionicons name="save-outline" size={16} color="#fff" />
                    <Text style={styles.btnPrimaryTxt}>Guardar y usar</Text>
                  </>
                )}
              </Pressable>
              <Pressable
                style={[styles.btn, styles.btnGhost, (saving || testing) && styles.btnDisabled]}
                onPress={onReset}
                disabled={saving || testing}
              >
                <Ionicons name="refresh-outline" size={16} color="#0F172A" />
                <Text style={styles.btnGhostTxt}>Restablecer</Text>
              </Pressable>
            </View>

            <Pressable
              style={[styles.btn, styles.btnSecondary, testing && styles.btnDisabled]}
              onPress={onTest}
              disabled={testing}
            >
              {testing ? (
                <ActivityIndicator color="#7C3AED" />
              ) : (
                <>
                  <Ionicons name="pulse-outline" size={16} color="#7C3AED" />
                  <Text style={styles.btnSecondaryTxt}>Probar conexión (GET /health)</Text>
                </>
              )}
            </Pressable>

            <View style={styles.state}>
              <Text style={styles.stateLabel}>URL activa (BASE):</Text>
              <Text style={styles.stateValue} selectable>
                {BASE || '(vacía)'}
              </Text>
              <Text style={styles.stateLabel}>Override guardado:</Text>
              <Text style={styles.stateValue} selectable>
                {storedUrl || '(ninguno — se usa EXPO_PUBLIC_BACKEND_URL)'}
              </Text>
            </View>

            {testResult ? (
              <View style={styles.result}>
                <Text style={styles.resultTitle}>Resultado prueba</Text>
                <Text style={styles.resultBody} selectable>
                  {testResult}
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default DebugNetworkModal;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '92%',
    minHeight: '55%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
  },
  title: { flex: 1, fontSize: 16, fontWeight: '800', color: '#0F172A' },
  closeBtn: { padding: 4 },
  body: { paddingHorizontal: 16, paddingTop: 12 },
  help: { fontSize: 13, color: '#334155', lineHeight: 18 },
  example: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    color: '#7C3AED',
    marginTop: 6,
    marginBottom: 12,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#0F172A',
    marginTop: 8,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#0F172A',
    backgroundColor: '#F8FAFC',
  },
  row: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  btnPrimary: { backgroundColor: '#7C3AED' },
  btnPrimaryTxt: { color: '#fff', fontWeight: '800', fontSize: 14 },
  btnGhost: { backgroundColor: '#F1F5F9', borderWidth: 1, borderColor: '#CBD5E1' },
  btnGhostTxt: { color: '#0F172A', fontWeight: '800', fontSize: 14 },
  btnSecondary: {
    marginTop: 10,
    backgroundColor: '#EDE9FE',
    borderWidth: 1,
    borderColor: '#C4B5FD',
  },
  btnSecondaryTxt: { color: '#7C3AED', fontWeight: '800', fontSize: 14 },
  btnDisabled: { opacity: 0.6 },
  state: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  stateLabel: { fontSize: 11, fontWeight: '700', color: '#64748B', marginTop: 4 },
  stateValue: {
    fontSize: 12,
    color: '#0F172A',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    marginTop: 2,
  },
  result: {
    marginTop: 16,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#0F172A',
  },
  resultTitle: { fontSize: 12, fontWeight: '800', color: '#94A3B8', marginBottom: 6 },
  resultBody: {
    fontSize: 11,
    color: '#E2E8F0',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    lineHeight: 15,
  },
});
