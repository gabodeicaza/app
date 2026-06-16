// SynCo v2.0 — Tab "Noticias" del Especialista / Sub-Coord (lectura).
// Lista noticias del proyecto, fijadas primero. Pull-to-refresh y polling cada 60s.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, AppState, AppStateStatus, Pressable, RefreshControl,
  ScrollView, StatusBar, StyleSheet, Text, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/src/auth-context';
import { api, Announcement } from '@/src/api';
import { colors, radius, shadow, spacing } from '@/src/theme';

const POLL_MS = 60000;

export default function NoticiasScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const projectId = (user?.project_ids || [])[0] || '';

  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!projectId) { setLoading(false); setError('Sin proyecto asignado'); return; }
    try {
      if (!silent) setLoading(true);
      setError(null);
      const data = await api.listAnnouncements(projectId);
      setItems(data);
    } catch (e: any) {
      setError(e?.message || 'No se pudieron cargar las noticias');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { load(false); }, [load]);

  // Polling cada 60s + refresh on foreground.
  useEffect(() => {
    function start() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => { load(true); }, POLL_MS);
    }
    function stop() {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    start();
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') { load(true); start(); } else { stop(); }
    });
    return () => { stop(); sub.remove(); };
  }, [load]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.blueTop, { height: 140 + insets.top }]} />

      <View style={[styles.header, { paddingTop: insets.top + spacing.xs }]}>
        <View style={styles.headerIcon}>
          <Ionicons name="newspaper" size={18} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Noticias</Text>
          <Text style={styles.headerSubtitle}>Anuncios del Coordinador General</Text>
        </View>
        <Pressable onPress={() => load(false)} hitSlop={10} style={styles.refreshBtn}>
          <Ionicons name="refresh" size={18} color="#fff" />
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xl, gap: spacing.sm }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(true); }}
            tintColor="#fff"
            colors={[colors.primary]}
          />
        }
      >
        {loading ? (
          <View style={styles.centerPad}><ActivityIndicator color={colors.primary} /></View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={22} color={colors.error} />
            <Text style={styles.errorTxt}>{error}</Text>
            <Pressable onPress={() => load(false)} style={styles.retryBtn}>
              <Text style={styles.retryTxt}>Reintentar</Text>
            </Pressable>
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyBox}>
            <View style={styles.emptyIcon}>
              <Ionicons name="newspaper-outline" size={28} color={colors.primary} />
            </View>
            <Text style={styles.emptyTitle}>Aún no hay noticias</Text>
            <Text style={styles.emptyMsg}>
              Cuando el Coordinador publique un anuncio, lo verás aquí.
            </Text>
          </View>
        ) : (
          items.map((a) => <AnnouncementCard key={a.id} item={a} />)
        )}
      </ScrollView>
    </View>
  );
}

function AnnouncementCard({ item }: { item: Announcement }) {
  return (
    <View style={[styles.card, item.pinned && styles.cardPinned]}>
      {item.pinned ? (
        <View style={styles.pinnedRow}>
          <Ionicons name="pin" size={11} color={colors.primary} />
          <Text style={styles.pinnedTxt}>Fijado</Text>
        </View>
      ) : null}
      <Text style={styles.cardTitle}>{item.title}</Text>
      <Text style={styles.cardBody}>{item.body}</Text>
      <View style={styles.cardMeta}>
        <Ionicons name="person-circle-outline" size={13} color={colors.textMuted} />
        <Text style={styles.cardMetaTxt}>{item.author_name}</Text>
        <Text style={styles.cardMetaDot}>·</Text>
        <Ionicons name="time-outline" size={12} color={colors.textMuted} />
        <Text style={styles.cardMetaTxt}>{formatDate(item.created_at)}</Text>
      </View>
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diff = now - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'Hace instantes';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h} h`;
  const dy = Math.floor(h / 24);
  if (dy < 7) return `Hace ${dy} d`;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  blueTop: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: colors.primary,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingHorizontal: spacing.md, paddingBottom: spacing.md,
  },
  headerIcon: {
    width: 36, height: 36, borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  headerSubtitle: { color: 'rgba(255,255,255,0.85)', fontSize: 11, marginTop: 1 },
  refreshBtn: {
    width: 36, height: 36, borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, gap: 6, ...shadow.card,
  },
  cardPinned: { borderColor: colors.primary, borderWidth: 1.5 },
  pinnedRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  pinnedTxt: { fontSize: 10, fontWeight: '800', color: colors.primary, letterSpacing: 0.6, textTransform: 'uppercase' },
  cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  cardBody: { fontSize: 13, color: colors.textBody, lineHeight: 20 },
  cardMeta: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4,
    paddingTop: 8, borderTopColor: colors.border, borderTopWidth: 1,
  },
  cardMetaTxt: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  cardMetaDot: { fontSize: 11, color: colors.textMuted, marginHorizontal: 2 },
  centerPad: { padding: spacing.xl, alignItems: 'center' },
  errorBox: {
    padding: spacing.lg, alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
  },
  errorTxt: { textAlign: 'center', color: colors.textBody, fontSize: 13 },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.md },
  retryTxt: { color: '#fff', fontWeight: '800', fontSize: 13 },
  emptyBox: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg,
    alignItems: 'center', gap: 6, ...shadow.card,
  },
  emptyIcon: {
    width: 56, height: 56, borderRadius: radius.full,
    backgroundColor: colors.primaryLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  emptyTitle: { fontSize: 15, fontWeight: '800', color: colors.text },
  emptyMsg: { fontSize: 12, color: colors.textBody, textAlign: 'center', lineHeight: 18 },
});
