import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/Button';
import { useAuth } from '@/src/auth-context';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

type Role = 'coordinador' | 'especialista';

interface AreaItem { id: string; name: string; color: string }

export default function RegisterScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [puesto, setPuesto] = useState('');
  const [role, setRole] = useState<Role>('especialista');
  const [areaId, setAreaId] = useState<string | null>(null);
  const [areas, setAreas] = useState<AreaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Areas endpoint needs auth; we sign in a temp "public" view via demo coord token? No.
        // Easier: open it unauthenticated by using a public endpoint... we don't have one.
        // Use a low-privilege guest fetch by attempting login with demo coord just to read areas would be wrong.
        // Instead: fetch /api/areas without token will return 401. So we use the seed list as fallback.
      } catch {}
    })();
  }, []);

  // Static seed list (matches backend SEED_AREAS) — used at registration time before auth.
  const SEED: AreaItem[] = [
    { id: 'geotecnia', name: 'Geotecnia', color: '#D97706' },
    { id: 'topografia', name: 'Topografía', color: '#059669' },
    { id: 'obracivil', name: 'Obra Civil', color: '#2563EB' },
    { id: 'seguridad', name: 'Seguridad', color: '#DC2626' },
    { id: 'calidad', name: 'Calidad', color: '#7C3AED' },
  ];
  const displayAreas = areas.length ? areas : SEED;

  // Sugerencias de puesto según el rol seleccionado
  const PUESTO_SUGGESTIONS_ESP: Record<string, string[]> = {
    geotecnia: ['Ingeniero(a) Geotécnico', 'Laboratorista', 'Asistente Geotécnico'],
    topografia: ['Topógrafo Senior', 'Cadenero', 'Asistente Topográfico'],
    obracivil: ['Residente de Obra', 'Maestro de Obra', 'Auxiliar de Obra'],
    seguridad: ['Supervisor HSE', 'Inspector de Seguridad', 'Brigadista'],
    calidad: ['Inspector(a) de Calidad', 'Aseguramiento de Calidad', 'Laboratorista QA/QC'],
  };
  const PUESTO_SUGGESTIONS_COORD = ['Director de Proyecto', 'Coordinador General', 'Gerente de Obra'];
  const puestoSuggestions =
    role === 'coordinador'
      ? PUESTO_SUGGESTIONS_COORD
      : (areaId && PUESTO_SUGGESTIONS_ESP[areaId]) || [];

  async function onSubmit() {
    if (!name.trim() || !email.trim() || password.length < 6) {
      setError('Completa todos los campos. Mínimo 6 caracteres.');
      return;
    }
    if (role === 'especialista' && !areaId) {
      setError('Selecciona un área asignada');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.register({
        email: email.trim().toLowerCase(),
        password,
        name: name.trim(),
        role,
        area: role === 'especialista' ? areaId : null,
        puesto: puesto.trim() || null,
      });
      // Auto-login after register
      const user = await login(email.trim().toLowerCase(), password);
      if (user.role === 'coordinador') router.replace('/(coordinador)');
      else router.replace('/(especialista)');
    } catch (e: any) {
      setError(e?.message || 'No se pudo crear la cuenta');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={styles.back}
        >
          <Ionicons name="chevron-back" size={22} color={colors.text} />
          <Text style={styles.backText}>Atrás</Text>
        </Pressable>

        <View style={styles.brand}>
          <Image
            source={require('../../assets/images/dirac-logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.brandTitle}>Crear cuenta</Text>
          <Text style={styles.brandSubtitle}>Únete al sistema de reporte de obra</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Nombre completo</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="person-outline" size={18} color={colors.textMuted} />
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Ej. Andrés Ramírez"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
          </View>

          <Text style={[styles.label, { marginTop: spacing.md }]}>Correo electrónico</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="mail-outline" size={18} color={colors.textMuted} />
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="nombre@empresa.com"
              placeholderTextColor={colors.textMuted}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          </View>

          <Text style={[styles.label, { marginTop: spacing.md }]}>Contraseña</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Mínimo 6 caracteres"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              style={styles.input}
            />
          </View>

          <Text style={[styles.label, { marginTop: spacing.md }]}>Rol</Text>
          <View style={styles.roleRow}>
            {(['especialista', 'coordinador'] as Role[]).map((r) => {
              const active = role === r;
              return (
                <Pressable
                  key={r}
                  onPress={() => {
                    setRole(r);
                    if (r === 'coordinador') setAreaId(null);
                  }}
                  style={[styles.rolePill, active && styles.rolePillActive]}
                >
                  <Ionicons
                    name={r === 'coordinador' ? 'briefcase' : 'hammer'}
                    size={16}
                    color={active ? colors.textInverse : colors.text}
                  />
                  <Text style={[styles.roleText, active && { color: colors.textInverse }]}>
                    {r === 'coordinador' ? 'Supervisor de Obra' : 'Especialista'}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {role === 'especialista' ? (
            <>
              <Text style={[styles.label, { marginTop: spacing.md }]}>Área asignada</Text>
              <View style={styles.areaGrid}>
                {displayAreas.map((a) => {
                  const active = areaId === a.id;
                  return (
                    <Pressable
                      key={a.id}
                      onPress={() => setAreaId(a.id)}
                      style={[
                        styles.areaPill,
                        active && { backgroundColor: a.color, borderColor: a.color },
                      ]}
                    >
                      <View
                        style={[styles.areaDot, { backgroundColor: active ? '#fff' : a.color }]}
                      />
                      <Text
                        style={[
                          styles.areaPillText,
                          active && { color: colors.textInverse },
                        ]}
                      >
                        {a.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          <Text style={[styles.label, { marginTop: spacing.md }]}>
            Puesto / Cargo <Text style={styles.optional}>(opcional)</Text>
          </Text>
          <View style={styles.inputWrap}>
            <Ionicons name="briefcase-outline" size={18} color={colors.textMuted} />
            <TextInput
              value={puesto}
              onChangeText={setPuesto}
              placeholder="Ej. Ingeniero(a) Geotécnico"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              autoCapitalize="words"
            />
          </View>
          {puestoSuggestions.length > 0 ? (
            <View style={styles.suggestRow}>
              {puestoSuggestions.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setPuesto(s)}
                  style={[styles.suggestPill, puesto === s && styles.suggestPillActive]}
                >
                  <Text
                    style={[
                      styles.suggestText,
                      puesto === s && { color: colors.textInverse },
                    ]}
                  >
                    {s}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={{ height: spacing.md }} />
          <Button label="Crear cuenta" loading={busy} onPress={onSubmit} fullWidth />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, flexGrow: 1 },
  back: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.sm },
  backText: { fontSize: 14, fontWeight: '700', color: colors.text },
  brand: { alignItems: 'center', marginVertical: spacing.md },
  logo: { width: 72, height: 72 },
  brandTitle: { fontSize: 22, fontWeight: '900', color: colors.text, marginTop: spacing.sm },
  brandSubtitle: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
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
  roleRow: { flexDirection: 'row', gap: 10 },
  rolePill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  rolePillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  roleText: { fontSize: 14, fontWeight: '700', color: colors.text },
  areaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  areaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  areaDot: { width: 8, height: 8, borderRadius: 4 },
  areaPillText: { fontSize: 13, fontWeight: '700', color: colors.text },
  optional: { color: colors.textMuted, fontWeight: '500' },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  suggestPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  suggestPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  suggestText: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.errorBg,
    padding: 10,
    borderRadius: radius.md,
    marginTop: spacing.md,
  },
  errorText: { color: colors.error, fontSize: 13, flex: 1, fontWeight: '600' },
});
