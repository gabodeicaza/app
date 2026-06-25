/**
 * Shared preview/detail modal for a Report (FeedItem).
 * Used by:
 *  - Coordinador/Jefe (coord)
 *  - Sub-coordinador (subcoord)
 *  - Especialista (spec)
 *
 * Design tokens are inlined to guarantee a consistent, readable, white sheet
 * across all roles (avoids legacy theme/sheet conflicts).
 */
import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  View,
  Text,
  Image,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FeedItem } from '@/src/api';
import { formatMeasurementValue } from '@/src/utils/whatsapp';

interface ReportPreviewSheetProps {
  visible: boolean;
  item: FeedItem | null;
  onClose: () => void;
  /** Optional share-via-WhatsApp callback. If omitted, the share button is hidden. */
  onShare?: (item: FeedItem) => void | Promise<void>;
}

export function ReportPreviewSheet({
  visible,
  item,
  onClose,
  onShare,
}: ReportPreviewSheetProps) {
  // Defensive: tolerate legacy/alt field names from the backend.
  const it = (item ?? {}) as Record<string, any>;

  const title =
    (it.node_path_names && it.node_path_names.slice(-1)[0]) || 'Reporte';
  const path = (it.node_path_names || []).join(' › ') || '—';
  const author =
    it.captured_by_name || it.user_name || it.author_name || 'Especialista';
  const area = it.area_name || 'Sin área asignada';
  const created = it.created_at
    ? new Date(it.created_at).toLocaleString('es-MX', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
  const photoUri: string | null = it.thumbnail_base64
    ? `data:image/jpeg;base64,${it.thumbnail_base64}`
    : it.foto || it.photo_url || null;

  const measurement = formatMeasurementValue(
    it.measurement_type,
    it.measurement_value || {},
  );
  const avance = it.avance ? String(it.avance) : '';
  const medicion = it.medicion ? String(it.medicion) : '';
  // Actividades: prefer explicit "actividades", fall back to notes/observaciones/comment.
  const actividadesRaw =
    it.actividades || it.notes || it.observaciones || it.comment || '';
  const actividades = String(actividadesRaw || '').trim();
  const hasActividades = actividades.length > 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Pressable hitSlop={10} onPress={onClose}>
              <Ionicons name="close" size={22} color="#0F172A" />
            </Pressable>
          </View>

          {/* Body */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {photoUri ? (
              <Image
                source={{ uri: photoUri }}
                style={styles.image}
                resizeMode="cover"
              />
            ) : (
              <View style={[styles.image, styles.imagePlaceholder]}>
                <Ionicons name="image-outline" size={40} color="#94A3B8" />
                <Text style={styles.imagePlaceholderTxt}>Sin foto adjunta</Text>
              </View>
            )}

            <Row icon="person-outline" text={author} />
            <Row icon="grid-outline" text={area} />
            <Row icon="location-outline" text={path} numberOfLines={3} />
            <Row icon="time-outline" text={created} />

            {measurement ? <Block title="Medición" body={measurement} /> : null}
            {avance ? <Block title="Avance" body={avance} /> : null}
            {medicion && !measurement ? (
              <Block title="Medición" body={medicion} />
            ) : null}

            {/* Actividades: vital block for the field crew. Always rendered. */}
            <Block
              title="Actividades"
              body={hasActividades ? actividades : 'Sin actividades registradas'}
              muted={!hasActividades}
            />
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            {onShare ? (
              <Pressable
                onPress={() => {
                  if (item && onShare) {
                    onClose();
                    setTimeout(() => onShare(item), 220);
                  }
                }}
                style={({ pressed }) => [
                  styles.waBtn,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Ionicons name="logo-whatsapp" size={18} color="#FFFFFF" />
                <Text style={styles.waTxt}>Compartir</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onClose}
              style={({ pressed }) => [
                styles.closeBtn,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={styles.closeTxt}>Cerrar</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function Row({
  icon,
  text,
  numberOfLines = 2,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
  numberOfLines?: number;
}) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={16} color="#64748B" />
      <Text style={styles.meta} numberOfLines={numberOfLines}>
        {text}
      </Text>
    </View>
  );
}

function Block({
  title,
  body,
  muted,
}: {
  title: string;
  body: string;
  muted?: boolean;
}) {
  return (
    <View style={styles.block}>
      <Text style={styles.blockTitle}>{title}</Text>
      <Text
        style={[
          styles.blockTxt,
          muted && { fontStyle: 'italic', color: '#94A3B8' },
        ]}
      >
        {body}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles — inlined hex colors to avoid theme drift across roles.
// ---------------------------------------------------------------------------
const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '92%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    gap: 12,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '800',
    color: '#0F172A',
  },
  scroll: {
    backgroundColor: '#FFFFFF',
  },
  scrollContent: {
    padding: 16,
    gap: 12,
    backgroundColor: '#FFFFFF',
  },
  image: {
    width: '100%',
    height: 250,
    borderRadius: 10,
    backgroundColor: '#DBEAFE',
  },
  imagePlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  imagePlaceholderTxt: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  meta: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
  },
  block: {
    backgroundColor: '#F8FAFC',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    padding: 12,
    gap: 4,
  },
  blockTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  blockTxt: {
    fontSize: 14,
    color: '#0F172A',
    lineHeight: 20,
    // Garantiza salto de línea para textos largos.
    flexShrink: 1,
  },
  footer: {
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    gap: 8,
  },
  closeBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1E40AF',
    borderRadius: 10,
  },
  closeTxt: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  waBtn: {
    flex: 1,
    flexDirection: 'row',
    minHeight: 44,
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#25D366',
    borderRadius: 10,
  },
  waTxt: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
});

export default ReportPreviewSheet;
