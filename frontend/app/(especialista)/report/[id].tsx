import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Image, ActivityIndicator, Pressable, Dimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { AppHeader } from '@/src/components/AppHeader';
import { AreaChip } from '@/src/components/AreaChip';
import { api } from '@/src/api';
import { colors, radius, spacing } from '@/src/theme';
import { fmtDateTime } from '@/src/utils/format';

const { width } = Dimensions.get('window');

export default function ReportDetailEsp() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [report, setReport] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.listReports();
        setReport(list.find((r: any) => r.id === id) || null);
      } catch {}
      finally { setLoading(false); }
    })();
  }, [id]);

  if (loading) {
    return (
      <View style={styles.flex}>
        <AppHeader title="Reporte" back />
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </View>
    );
  }

  if (!report) {
    return (
      <View style={styles.flex}>
        <AppHeader title="Reporte" back />
        <View style={styles.center}><Text style={styles.muted}>Reporte no encontrado</Text></View>
      </View>
    );
  }

  if (zoom) {
    return (
      <Pressable style={styles.zoomWrap} onPress={() => setZoom(null)}>
        <Image source={{ uri: zoom }} style={styles.zoomImg} resizeMode="contain" />
        <View style={[styles.zoomClose, { top: insets.top + 8 }]}>
          <Ionicons name="close" size={28} color="#fff" />
        </View>
      </Pressable>
    );
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Detalle del reporte" back />
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.card}>
          <View style={styles.topRow}>
            <AreaChip name={report.areaName} />
            <Text style={styles.time}>{fmtDateTime(report.createdAt)}</Text>
          </View>
          <Text style={styles.title}>{report.title}</Text>
          {report.comments ? <Text style={styles.comments}>{report.comments}</Text> : null}
          <View style={styles.metaRow}>
            <Ionicons name="person-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta}>{report.createdByName}</Text>
          </View>
          <View style={styles.metaRow}>
            <Ionicons name="images-outline" size={14} color={colors.textMuted} />
            <Text style={styles.meta}>{report.images?.length || 0} foto{report.images?.length === 1 ? '' : 's'}</Text>
          </View>
        </View>

        {report.images?.length ? (
          <>
            <Text style={styles.section}>Evidencia fotográfica</Text>
            <View style={styles.grid}>
              {report.images.map((img: string, i: number) => (
                <Pressable key={i} onPress={() => setZoom(img)} style={styles.cell}>
                  <Image source={{ uri: img }} style={styles.gridImg} />
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const CELL = (width - spacing.md * 2 - spacing.sm) / 2;

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: spacing.md, gap: spacing.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { color: colors.textMuted, fontSize: 14 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  time: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  title: { fontSize: 18, fontWeight: '900', color: colors.text, marginTop: spacing.sm },
  comments: { fontSize: 14, color: colors.textBody, marginTop: 6, lineHeight: 20 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  meta: { fontSize: 12, color: colors.textMuted, fontWeight: '600' },
  section: { fontSize: 14, fontWeight: '800', color: colors.text, marginTop: spacing.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  cell: { width: CELL, height: CELL, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.border },
  gridImg: { width: '100%', height: '100%' },
  zoomWrap: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  zoomImg: { width: '100%', height: '100%' },
  zoomClose: { position: 'absolute', right: 16 },
});
