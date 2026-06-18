// Panel “Progreso por nodo” con gráficas circulares.
// Calcula el porcentaje = (reportes asociados al nodo) / meta * 100.
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CircularProgress from 'react-native-circular-progress-indicator';
import { api, FeedItem, LocationNode } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';

type Props = {
  projectId: string;
  reports: FeedItem[];
};

export function NodeProgressPanel({ projectId, reports }: Props) {
  const [nodes, setNodes] = useState<LocationNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!projectId) return;
      try {
        setError(null);
        const list = await api.listNodes(projectId);
        if (!alive) return;
        setNodes(list || []);
      } catch (e: any) {
        if (!alive) return;
        setError(e?.message || 'No se pudieron cargar los nodos');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [projectId]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of reports) {
      map.set(r.node_id, (map.get(r.node_id) || 0) + 1);
    }
    return map;
  }, [reports]);

  const items = useMemo(
    () => nodes
      .filter((n) => typeof n.meta === 'number' && (n.meta || 0) > 0)
      .sort((a, b) => (b.meta || 0) - (a.meta || 0))
      .slice(0, 12),
    [nodes],
  );

  if (loading) {
    return (
      <View style={styles.card}>
        <PanelHeader count={0} />
        <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.card}>
        <PanelHeader count={0} />
        <View style={styles.errBox}>
          <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
          <Text style={styles.errTxt}>{error}</Text>
        </View>
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.card}>
        <PanelHeader count={0} />
        <View style={styles.emptyBox}>
          <Ionicons name="pie-chart-outline" size={20} color={colors.textMuted} />
          <Text style={styles.emptyTxt}>
            Aún no hay metas numéricas en los nodos. Definílas en el árbol del proyecto para visualizar el avance.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <PanelHeader count={items.length} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.sm, paddingHorizontal: 2 }}
      >
        {items.map((n) => {
          const meta = n.meta || 0;
          const current = counts.get(n.id) || 0;
          const pctRaw = meta > 0 ? Math.min(100, Math.round((current / meta) * 100)) : 0;
          const tint = pctRaw >= 100 ? colors.success : pctRaw >= 50 ? colors.primary : colors.warning;
          return (
            <View key={n.id} style={styles.tile}>
              <CircularProgress
                value={pctRaw}
                radius={42}
                maxValue={100}
                duration={650}
                progressValueColor={colors.text}
                activeStrokeColor={tint}
                inActiveStrokeColor={colors.border}
                inActiveStrokeOpacity={0.5}
                inActiveStrokeWidth={8}
                activeStrokeWidth={9}
                valueSuffix="%"
                titleFontSize={9}
                progressValueFontSize={16}
              />
              <Text style={styles.tileName} numberOfLines={2}>{n.name}</Text>
              <Text style={styles.tileMeta}>{current} / {meta}</Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function PanelHeader({ count }: { count: number }) {
  return (
    <View style={styles.headerRow}>
      <View style={styles.headerIcon}>
        <Ionicons name="pie-chart" size={16} color="#fff" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>Avance por nodo</Text>
        <Text style={styles.subtitle}>
          {count === 0 ? 'Configura metas numéricas en los nodos' : `${count} nodos con meta activa`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadow.card,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerIcon: {
    width: 32, height: 32, borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 15, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, marginTop: 2, fontWeight: '600' },

  center: { padding: spacing.md, alignItems: 'center' },
  errBox: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: spacing.sm },
  errTxt: { color: colors.textBody, fontSize: 12, flex: 1 },

  emptyBox: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  emptyTxt: { fontSize: 12, color: colors.textMuted, flex: 1, lineHeight: 18 },

  tile: {
    width: 112,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  tileName: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
    marginTop: 6,
  },
  tileMeta: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '700',
  },
});
