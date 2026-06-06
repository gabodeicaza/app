import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';

export default function SummaryScreen() {
  const insets = useSafeAreaInsets();
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const today = await api.reportsToday();
      setCount(today.total || 0);
      if (!today.reports?.length) {
        setSummary(null);
        setError('No hay reportes hoy para resumir.');
        return;
      }
      const res = await api.dailySummary(today.reports);
      setSummary(res.summary);
    } catch (e: any) {
      setError(e?.message || 'No se pudo generar el resumen');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Resumen ejecutivo" subtitle="Generado por IA (Gemini 2.5)" />
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.intro}>
          <View style={styles.iaBadge}>
            <Ionicons name="sparkles" size={14} color="#fff" />
            <Text style={styles.iaBadgeText}>Inteligencia Artificial</Text>
          </View>
          <Text style={styles.introTitle}>Reporte ejecutivo del día</Text>
          <Text style={styles.introSub}>
            Combinamos todos los reportes enviados hoy por los especialistas y generamos un resumen ejecutivo agrupado por área, con foco en problemas y avance del día.
          </Text>
          <View style={{ height: spacing.md }} />
          <Button
            label={summary ? 'Volver a generar' : 'Generar resumen'}
            onPress={generate}
            loading={busy}
            variant="ai"
            icon={<Ionicons name="sparkles" size={16} color="#fff" />}
            fullWidth
          />
        </View>

        {busy ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color={colors.primary} />
            <Text style={styles.loadingText}>Analizando reportes…</Text>
          </View>
        ) : error ? (
          <View style={styles.errorCard}>
            <Ionicons name="information-circle" size={18} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : summary ? (
          <View style={styles.summaryCard}>
            <View style={styles.summaryHead}>
              <Ionicons name="document-text" size={16} color={colors.primary} />
              <Text style={styles.summaryHeadText}>Resumen — {count} reporte{count === 1 ? '' : 's'}</Text>
            </View>
            <Text style={styles.summaryText}>{summary}</Text>
          </View>
        ) : (
          <View style={styles.placeholder}>
            <Ionicons name="sparkles-outline" size={36} color={colors.textMuted} />
            <Text style={styles.placeholderText}>Pulsa "Generar resumen" para crear el reporte ejecutivo del día.</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.md },
  intro: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  iaBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#0F172A',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  iaBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.4 },
  introTitle: { fontSize: 18, fontWeight: '900', color: colors.text, marginTop: spacing.sm },
  introSub: { fontSize: 13, color: colors.textBody, marginTop: 6, lineHeight: 19 },
  summaryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: spacing.sm },
  summaryHeadText: { fontSize: 13, fontWeight: '800', color: colors.primary },
  summaryText: { fontSize: 14, color: colors.text, lineHeight: 22 },
  loadingCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    gap: 8,
  },
  loadingText: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.errorBg,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: { color: colors.error, fontSize: 13, fontWeight: '700', flex: 1 },
  placeholder: { alignItems: 'center', padding: spacing.lg, gap: 8 },
  placeholderText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', maxWidth: 260 },
});
