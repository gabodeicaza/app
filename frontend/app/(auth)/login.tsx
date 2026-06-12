import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/Button';
import { useAuth } from '@/src/auth-context';
import { colors, radius, spacing } from '@/src/theme';

export default function LoginScreen() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    if (!email.trim() || !password) {
      setError('Ingresa tu correo y contraseña');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await login(email.trim().toLowerCase(), password);
      const su = ['coordinador', 'supervisor_general', 'supervisor_t1', 'supervisor_t2', 'contratista', 'dependencia'];
      if (su.includes(user.role)) router.replace('/(coordinador)/noticias');
      else router.replace('/(especialista)/noticias');
    } catch (e: any) {
      setError(e?.message || 'No se pudo iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  function useDemo(kind: 'coord' | 'esp') {
    if (kind === 'coord') {
      setEmail('coordinador@syncsite.com');
      setPassword('demo1234');
    } else {
      setEmail('obracivil@syncsite.com');
      setPassword('demo1234');
    }
    setError(null);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.brand}>
          <Image
            source={require('../../assets/images/dirac-logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.brandName}>SynCo</Text>
          <Text style={styles.brandTagline}>Reporte de obra inteligente, sin huella local.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Iniciar sesión</Text>

          <Text style={styles.label}>Correo electrónico</Text>
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
              returnKeyType="next"
            />
          </View>

          <Text style={[styles.label, { marginTop: spacing.md }]}>Contraseña</Text>
          <View style={styles.inputWrap}>
            <Ionicons name="lock-closed-outline" size={18} color={colors.textMuted} />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPwd}
              style={styles.input}
              returnKeyType="go"
              onSubmitEditing={onSubmit}
            />
            <Pressable onPress={() => setShowPwd((v) => !v)} hitSlop={8}>
              <Ionicons
                name={showPwd ? 'eye-off-outline' : 'eye-outline'}
                size={18}
                color={colors.textMuted}
              />
            </Pressable>
          </View>

          {error ? (
            <View style={styles.errorBox}>
              <Ionicons name="alert-circle" size={16} color={colors.error} />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={{ height: spacing.md }} />
          <Button label="Entrar" loading={busy} onPress={onSubmit} fullWidth />

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>cuentas demo</Text>
            <View style={styles.dividerLine} />
          </View>

          <View style={styles.demoRow}>
            <Pressable onPress={() => useDemo('coord')} style={styles.demoBtn}>
              <Ionicons name="briefcase-outline" size={14} color={colors.primary} />
              <Text style={styles.demoText}>Supervisor de Obra</Text>
            </Pressable>
            <Pressable onPress={() => useDemo('esp')} style={styles.demoBtn}>
              <Ionicons name="hammer-outline" size={14} color={colors.primary} />
              <Text style={styles.demoText}>Especialista</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>¿No tienes cuenta?</Text>
          <Link href="/(auth)/register" asChild>
            <Pressable hitSlop={6}>
              <Text style={styles.footerLink}>Crear cuenta</Text>
            </Pressable>
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, flexGrow: 1 },
  brand: { alignItems: 'center', marginTop: spacing.sm, marginBottom: spacing.lg },
  logo: { width: 96, height: 96 },
  brandName: {
    fontSize: 28,
    fontWeight: '900',
    letterSpacing: -0.5,
    color: colors.primary,
    marginTop: spacing.sm,
  },
  brandTagline: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 4,
    textAlign: 'center',
    maxWidth: 280,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.text,
    marginBottom: spacing.md,
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
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: spacing.md,
  },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { fontSize: 11, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  demoRow: { flexDirection: 'row', gap: 10 },
  demoBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primaryLight,
    backgroundColor: colors.primaryLight + '55',
  },
  demoText: { fontSize: 13, fontWeight: '700', color: colors.primary },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.lg,
  },
  footerText: { color: colors.textMuted, fontSize: 13 },
  footerLink: { color: colors.primary, fontSize: 13, fontWeight: '800' },
});
