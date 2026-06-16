import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Alert,
  Modal, TextInput, KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/src/components/Button';
import { api, LocationNode, LocationNodeTree } from '@/src/api';
import { colors, radius, spacing, shadow } from '@/src/theme';
import { MEASUREMENT_LABELS, MEASUREMENT_ICONS, MeasurementType } from '@/src/utils/roles';
import { confirm } from '@/src/utils/confirm';

// =============================================================================
// Constructor visual del Árbol de Nodos
// =============================================================================

type EditorMode =
  | { kind: 'create_root' }
  | { kind: 'create_child'; parent: LocationNodeTree }
  | { kind: 'edit'; node: LocationNodeTree };

export default function TreeBuilderScreen() {
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const pid = (Array.isArray(id) ? id[0] : id) || '';

  const [tree, setTree] = useState<LocationNodeTree[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<EditorMode | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const items = await api.getTree(pid);
      setTree(items || []);
      // expand root nodes by default the first time
      setExpanded((prev) => {
        if (Object.keys(prev).length > 0) return prev;
        const init: Record<string, boolean> = {};
        (items || []).forEach((n) => { init[n.id] = true; });
        return init;
      });
    } catch (e: any) {
      setError(e?.message || 'Error al cargar el árbol');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [pid]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const totalCount = useMemo(() => countNodes(tree), [tree]);
  const leafCount = useMemo(() => countLeaves(tree), [tree]);

  function toggle(nodeId: string) {
    setExpanded((prev) => ({ ...prev, [nodeId]: !prev[nodeId] }));
  }

  function expandAll() {
    const map: Record<string, boolean> = {};
    function walk(ns: LocationNodeTree[]) {
      for (const n of ns) { map[n.id] = true; walk(n.children); }
    }
    walk(tree);
    setExpanded(map);
  }

  function collapseAll() {
    setExpanded({});
  }

  async function onDelete(node: LocationNodeTree) {
    const childrenCount = countNodes(node.children);
    const msg = childrenCount === 0
      ? `¿Eliminar el nodo "${node.name}"?`
      : `¿Eliminar "${node.name}" y sus ${childrenCount} descendiente(s)? Esta acción no se puede deshacer.`;
    const ok = await confirm('Eliminar nodo', msg, { confirmText: 'Eliminar', destructive: true });
    if (!ok) return;
    try {
      await api.deleteNode(node.id);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'No se pudo eliminar');
    }
  }

  async function onSave(payload: { name: string; is_leaf: boolean; measurement_type: MeasurementType | null; target_lat: number | null; target_lon: number | null; target_elev: number | null }) {
    if (!editor) return;
    try {
      const isCoordLeaf = payload.is_leaf && payload.measurement_type === 'coord_latlon';
      const targets = {
        target_lat: isCoordLeaf ? payload.target_lat : null,
        target_lon: isCoordLeaf ? payload.target_lon : null,
        target_elev: isCoordLeaf ? payload.target_elev : null,
      };
      if (editor.kind === 'edit') {
        await api.updateNode(editor.node.id, {
          name: payload.name,
          is_leaf: payload.is_leaf,
          measurement_type: payload.is_leaf ? payload.measurement_type : null,
          ...targets,
        });
      } else {
        const parent_id = editor.kind === 'create_child' ? editor.parent.id : null;
        await api.createNode(pid, {
          project_id: pid,
          parent_id,
          name: payload.name,
          is_leaf: payload.is_leaf,
          measurement_type: payload.is_leaf ? payload.measurement_type : null,
          ...targets,
        });
        if (parent_id) setExpanded((e) => ({ ...e, [parent_id]: true }));
      }
      setEditor(null);
      await load();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'No se pudo guardar');
    }
  }

  return (
    <View style={[styles.flex, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={24} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Árbol de nodos</Text>
          <Text style={styles.subtitle}>{totalCount} nodo{totalCount === 1 ? '' : 's'} · {leafCount} hoja{leafCount === 1 ? '' : 's'}</Text>
        </View>
        <Pressable onPress={tree.length === 0 ? undefined : expandAll} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="expand" size={20} color={tree.length === 0 ? colors.textMuted : colors.text} />
        </Pressable>
        <Pressable onPress={tree.length === 0 ? undefined : collapseAll} hitSlop={8} style={styles.iconBtn}>
          <Ionicons name="contract" size={20} color={tree.length === 0 ? colors.textMuted : colors.text} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 110 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.primary} />}
      >
        {loading ? (
          <View style={styles.center}><ActivityIndicator color={colors.primary} /></View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={18} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : tree.length === 0 ? (
          <View style={styles.emptyBlock}>
            <Ionicons name="git-network-outline" size={56} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>El árbol está vacío</Text>
            <Text style={styles.emptyMsg}>
              Define la estructura espacial de tu proyecto. Puedes anidar tantos niveles como necesites. Los nodos hoja son los puntos donde el Especialista captura mediciones.
            </Text>
          </View>
        ) : (
          <View style={{ gap: 4 }}>
            {tree.map((n) => (
              <NodeBranch
                key={n.id}
                node={n}
                expanded={expanded}
                onToggle={toggle}
                onAddChild={(p) => setEditor({ kind: 'create_child', parent: p })}
                onEdit={(node) => setEditor({ kind: 'edit', node })}
                onDelete={onDelete}
              />
            ))}
          </View>
        )}
      </ScrollView>

      <Pressable style={[styles.fab, { bottom: insets.bottom + 20 }]} onPress={() => setEditor({ kind: 'create_root' })}>
        <Ionicons name="add" size={26} color={colors.textInverse} />
        <Text style={styles.fabText}>Agregar nodo raíz</Text>
      </Pressable>

      <NodeEditorModal
        visible={!!editor}
        editor={editor}
        onClose={() => setEditor(null)}
        onSave={onSave}
      />
    </View>
  );
}

// =============================================================================
// Componente recursivo de rama
// =============================================================================

function NodeBranch({
  node, expanded, onToggle, onAddChild, onEdit, onDelete,
}: {
  node: LocationNodeTree;
  expanded: Record<string, boolean>;
  onToggle: (id: string) => void;
  onAddChild: (parent: LocationNodeTree) => void;
  onEdit: (node: LocationNodeTree) => void;
  onDelete: (node: LocationNodeTree) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isOpen = !!expanded[node.id];
  const hasChildren = node.children.length > 0;
  const indent = Math.min(node.depth, 6) * 16;
  const isLeaf = node.is_leaf && !hasChildren;
  const mtype = node.measurement_type as MeasurementType | null;

  return (
    <View>
      <View style={[styles.row, { paddingLeft: indent + 4 }]}>
        {/* Vertical guide */}
        {node.depth > 0 ? <View style={[styles.guide, { left: indent - 6 }]} /> : null}

        {/* Toggle / spacer */}
        <Pressable
          onPress={() => hasChildren && onToggle(node.id)}
          hitSlop={6}
          style={styles.toggleBtn}
          disabled={!hasChildren}
        >
          {hasChildren ? (
            <Ionicons name={isOpen ? 'chevron-down' : 'chevron-forward'} size={16} color={colors.textBody} />
          ) : (
            <View style={styles.bullet} />
          )}
        </Pressable>

        {/* Node icon */}
        <View style={[styles.nodeIcon, isLeaf && styles.nodeIconLeaf]}>
          <Ionicons
            name={isLeaf ? (mtype ? (MEASUREMENT_ICONS[mtype] as any) : 'flag-outline') : (hasChildren ? 'folder' : 'folder-outline')}
            size={15}
            color={isLeaf ? colors.primary : colors.textBody}
          />
        </View>

        {/* Label */}
        <Pressable
          style={{ flex: 1, paddingVertical: 6 }}
          onPress={() => hasChildren ? onToggle(node.id) : onEdit(node)}
          onLongPress={() => onEdit(node)}
        >
          <Text style={styles.nodeName} numberOfLines={1}>{node.name}</Text>
          <View style={styles.metaRow}>
            {isLeaf && mtype ? (
              <View style={styles.leafBadge}>
                <Text style={styles.leafBadgeText}>{MEASUREMENT_LABELS[mtype]}</Text>
              </View>
            ) : null}
            {hasChildren ? (
              <Text style={styles.childCount}>{node.children.length} hijo{node.children.length === 1 ? '' : 's'}</Text>
            ) : !isLeaf ? (
              <Text style={styles.muted}>Vacío</Text>
            ) : null}
          </View>
        </Pressable>

        {/* Quick actions */}
        <Pressable onPress={() => onAddChild(node)} hitSlop={6} style={styles.actionBtn}>
          <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
        </Pressable>
        <Pressable onPress={() => setMenuOpen((o) => !o)} hitSlop={6} style={styles.actionBtn}>
          <Ionicons name="ellipsis-vertical" size={18} color={colors.textBody} />
        </Pressable>
      </View>

      {/* Inline action menu */}
      {menuOpen ? (
        <View style={[styles.menu, { marginLeft: indent + 36 }]}>
          <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); onEdit(node); }}>
            <Ionicons name="create-outline" size={16} color={colors.textBody} />
            <Text style={styles.menuText}>Editar</Text>
          </Pressable>
          <Pressable style={styles.menuItem} onPress={() => { setMenuOpen(false); onAddChild(node); }}>
            <Ionicons name="git-branch-outline" size={16} color={colors.textBody} />
            <Text style={styles.menuText}>Agregar nodo hijo</Text>
          </Pressable>
          <Pressable style={[styles.menuItem, styles.menuDanger]} onPress={() => { setMenuOpen(false); onDelete(node); }}>
            <Ionicons name="trash-outline" size={16} color={colors.error} />
            <Text style={[styles.menuText, { color: colors.error }]}>Eliminar</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Children */}
      {isOpen && hasChildren ? (
        <View>
          {node.children.map((c) => (
            <NodeBranch
              key={c.id}
              node={c}
              expanded={expanded}
              onToggle={onToggle}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// =============================================================================
// Modal de edición / creación de nodo
// =============================================================================

function NodeEditorModal({
  visible, editor, onClose, onSave,
}: {
  visible: boolean;
  editor: EditorMode | null;
  onClose: () => void;
  onSave: (p: { name: string; is_leaf: boolean; measurement_type: MeasurementType | null; target_lat: number | null; target_lon: number | null; target_elev: number | null }) => Promise<void>;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [isLeaf, setIsLeaf] = useState(false);
  const [mtype, setMtype] = useState<MeasurementType | null>(null);
  const [tLat, setTLat] = useState('');
  const [tLon, setTLon] = useState('');
  const [tElev, setTElev] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  React.useEffect(() => {
    if (!visible || !editor) return;
    if (editor.kind === 'edit') {
      setName(editor.node.name);
      setIsLeaf(editor.node.is_leaf);
      setMtype((editor.node.measurement_type as MeasurementType | null) || null);
      const n: any = editor.node;
      setTLat(n.target_lat != null ? String(n.target_lat) : '');
      setTLon(n.target_lon != null ? String(n.target_lon) : '');
      setTElev(n.target_elev != null ? String(n.target_elev) : '');
    } else {
      setName(''); setIsLeaf(false); setMtype(null);
      setTLat(''); setTLon(''); setTElev('');
    }
    setErr(null);
  }, [visible, editor]);

  const title = useMemo(() => {
    if (!editor) return '';
    if (editor.kind === 'edit') return `Editar: ${editor.node.name}`;
    if (editor.kind === 'create_child') return `Hijo de “${editor.parent.name}”`;
    return 'Nuevo nodo raíz';
  }, [editor]);

  // Helper para parsear coordenada (admite punto o coma como separador decimal).
  function parseCoord(raw: string): number | null {
    const s = (raw || '').trim().replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN as any;
  }

  async function submit() {
    setErr(null);
    const n = name.trim();
    if (!n) { setErr('El nombre es obligatorio'); return; }
    if (isLeaf && !mtype) { setErr('Selecciona el tipo de medición para el nodo hoja'); return; }
    let parsedLat: number | null = null;
    let parsedLon: number | null = null;
    let parsedElev: number | null = null;
    if (isLeaf && mtype === 'coord_latlon') {
      parsedLat = parseCoord(tLat);
      parsedLon = parseCoord(tLon);
      parsedElev = parseCoord(tElev);
      if (Number.isNaN(parsedLat as any)) { setErr('Latitud inválida'); return; }
      if (Number.isNaN(parsedLon as any)) { setErr('Longitud inválida'); return; }
      if (Number.isNaN(parsedElev as any)) { setErr('Elevación inválida'); return; }
      if (parsedLat != null && (parsedLat < -90 || parsedLat > 90)) { setErr('Latitud fuera de rango (-90 a 90)'); return; }
      if (parsedLon != null && (parsedLon < -180 || parsedLon > 180)) { setErr('Longitud fuera de rango (-180 a 180)'); return; }
    }
    setBusy(true);
    try {
      await onSave({
        name: n,
        is_leaf: isLeaf,
        measurement_type: isLeaf ? mtype : null,
        target_lat: parsedLat,
        target_lon: parsedLon,
        target_elev: parsedElev,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ width: '100%' }}>
          <View style={[styles.modalCard, { paddingBottom: insets.bottom + spacing.md }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle} numberOfLines={1}>{title}</Text>
              <Pressable onPress={onClose} hitSlop={8}><Ionicons name="close" size={24} color={colors.text} /></Pressable>
            </View>

            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.sm }}>
              <View>
                <Text style={styles.label}>Nombre del nodo</Text>
                <View style={styles.inputWrap}>
                  <Ionicons name="pricetag-outline" size={18} color={colors.textMuted} />
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    placeholder="Ej. Tramo 1, Estación 02+450, Eje A"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    autoFocus
                    autoCapitalize="sentences"
                    editable={!busy}
                    returnKeyType="done"
                  />
                </View>
              </View>

              <Pressable
                onPress={() => setIsLeaf((v) => !v)}
                style={[styles.leafToggle, isLeaf && styles.leafToggleOn]}
              >
                <Ionicons
                  name={isLeaf ? 'flag' : 'flag-outline'}
                  size={20}
                  color={isLeaf ? colors.primary : colors.textBody}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.leafToggleTitle, isLeaf && { color: colors.primary }]}>
                    Es nodo hoja (captura mediciones)
                  </Text>
                  <Text style={styles.leafToggleSub}>
                    Los nodos hoja son los puntos donde el Especialista registra mediciones.
                  </Text>
                </View>
                <View style={[styles.switch, isLeaf && styles.switchOn]}>
                  <View style={[styles.switchThumb, isLeaf && styles.switchThumbOn]} />
                </View>
              </Pressable>

              {isLeaf ? (
                <View>
                  <Text style={styles.label}>Tipo de medición</Text>
                  <View style={{ gap: 8 }}>
                    {(Object.keys(MEASUREMENT_LABELS) as MeasurementType[]).map((k) => (
                      <Pressable
                        key={k}
                        onPress={() => setMtype(k)}
                        style={[styles.mOption, mtype === k && styles.mOptionOn]}
                      >
                        <Ionicons
                          name={MEASUREMENT_ICONS[k] as any}
                          size={20}
                          color={mtype === k ? colors.primary : colors.textBody}
                        />
                        <Text style={[styles.mOptionText, mtype === k && { color: colors.primary, fontWeight: '800' }]}>
                          {MEASUREMENT_LABELS[k]}
                        </Text>
                        {mtype === k ? <Ionicons name="checkmark-circle" size={20} color={colors.primary} /> : null}
                      </Pressable>
                    ))}
                  </View>

                  {mtype === 'coord_latlon' ? (
                    <View style={styles.coordCard}>
                      <View style={styles.coordHeader}>
                        <Ionicons name="location" size={16} color={colors.primary} />
                        <Text style={styles.coordHeaderText}>Coordenadas objetivo (oficina)</Text>
                      </View>
                      <Text style={styles.coordHelp}>
                        Valores dictados por el Coordinador. El Especialista los verá en modo solo-lectura al capturar este nodo.
                      </Text>
                      <View style={styles.coordRow}>
                        <View style={styles.coordField}>
                          <Text style={styles.coordLabel}>Latitud (X)</Text>
                          <View style={styles.inputWrap}>
                            <Ionicons name="locate-outline" size={16} color={colors.textMuted} />
                            <TextInput
                              value={tLat}
                              onChangeText={setTLat}
                              placeholder="19.432608"
                              placeholderTextColor={colors.textMuted}
                              style={styles.input}
                              keyboardType="numbers-and-punctuation"
                              autoCorrect={false}
                              editable={!busy}
                            />
                          </View>
                        </View>
                        <View style={styles.coordField}>
                          <Text style={styles.coordLabel}>Longitud (Y)</Text>
                          <View style={styles.inputWrap}>
                            <Ionicons name="locate-outline" size={16} color={colors.textMuted} />
                            <TextInput
                              value={tLon}
                              onChangeText={setTLon}
                              placeholder="-99.133209"
                              placeholderTextColor={colors.textMuted}
                              style={styles.input}
                              keyboardType="numbers-and-punctuation"
                              autoCorrect={false}
                              editable={!busy}
                            />
                          </View>
                        </View>
                      </View>
                      <View style={styles.coordField}>
                        <Text style={styles.coordLabel}>Elevación / Cota (Z)</Text>
                        <View style={styles.inputWrap}>
                          <Ionicons name="trending-up-outline" size={16} color={colors.textMuted} />
                          <TextInput
                            value={tElev}
                            onChangeText={setTElev}
                            placeholder="2240.50 (msnm)"
                            placeholderTextColor={colors.textMuted}
                            style={styles.input}
                            keyboardType="numbers-and-punctuation"
                            autoCorrect={false}
                            editable={!busy}
                          />
                        </View>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {err ? (
                <View style={styles.errorBoxInline}>
                  <Ionicons name="alert-circle" size={16} color={colors.error} />
                  <Text style={styles.errorText}>{err}</Text>
                </View>
              ) : null}

              <View style={{ height: 4 }} />
              <Button label={editor?.kind === 'edit' ? 'Guardar cambios' : 'Crear nodo'} onPress={submit} loading={busy} fullWidth />
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function countNodes(tree: LocationNodeTree[]): number {
  let n = 0;
  for (const node of tree) { n += 1 + countNodes(node.children); }
  return n;
}
function countLeaves(tree: LocationNodeTree[]): number {
  let n = 0;
  for (const node of tree) {
    if (node.is_leaf && node.children.length === 0) n += 1;
    n += countLeaves(node.children);
  }
  return n;
}

// =============================================================================
// Styles
// =============================================================================

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 17, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 11, color: colors.textMuted, fontWeight: '700', marginTop: 1 },
  scroll: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, gap: spacing.sm },
  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  errorBox: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.errorBg, padding: 10, borderRadius: radius.md },
  errorText: { color: colors.error, fontSize: 13, flex: 1, fontWeight: '600' },
  emptyBlock: { alignItems: 'center', paddingVertical: spacing.xl + 12, gap: 8, paddingHorizontal: spacing.md },
  emptyTitle: { fontSize: 17, fontWeight: '800', color: colors.text, marginTop: 8 },
  emptyMsg: { fontSize: 13, color: colors.textMuted, textAlign: 'center', maxWidth: 320, lineHeight: 19 },

  // Branch row
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingRight: 6, position: 'relative',
  },
  guide: { position: 'absolute', top: 0, bottom: 0, width: 1.5, backgroundColor: colors.border },
  toggleBtn: { width: 26, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  bullet: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.borderStrong },
  nodeIcon: {
    width: 30, height: 30, borderRadius: radius.md,
    backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center',
    marginRight: 8, borderWidth: 1, borderColor: colors.border,
  },
  nodeIconLeaf: { backgroundColor: colors.primaryLight, borderColor: colors.primaryLight },
  nodeName: { fontSize: 14, fontWeight: '700', color: colors.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' },
  leafBadge: { backgroundColor: colors.primary, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  leafBadgeText: { fontSize: 9, fontWeight: '800', color: colors.textInverse, letterSpacing: 0.4, textTransform: 'uppercase' },
  childCount: { fontSize: 11, color: colors.textMuted, fontWeight: '700' },
  muted: { fontSize: 11, color: colors.textMuted, fontStyle: 'italic' },
  actionBtn: { padding: 6 },

  // Menu
  menu: {
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.md, marginTop: 4, marginBottom: 4, paddingVertical: 4, ...shadow.card,
  },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  menuDanger: { borderTopWidth: 1, borderTopColor: colors.border },
  menuText: { fontSize: 13, fontWeight: '700', color: colors.textBody },

  // FAB
  fab: {
    position: 'absolute', right: spacing.lg, alignSelf: 'flex-end',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primary, paddingHorizontal: 18, paddingVertical: 12,
    borderRadius: radius.full, ...shadow.card,
  },
  fabText: { color: colors.textInverse, fontWeight: '800', fontSize: 14 },

  // Modal
  modalBackdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: colors.surface, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, maxHeight: '90%',
  },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  modalTitle: { fontSize: 17, fontWeight: '800', color: colors.text, flex: 1 },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingHorizontal: 12, backgroundColor: colors.surface,
  },
  input: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.text },
  leafToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 12, backgroundColor: colors.bg,
  },
  leafToggleOn: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  leafToggleTitle: { fontSize: 14, fontWeight: '800', color: colors.text },
  leafToggleSub: { fontSize: 11, color: colors.textMuted, marginTop: 2, lineHeight: 15 },
  switch: {
    width: 38, height: 22, borderRadius: 11, backgroundColor: colors.border,
    justifyContent: 'center', paddingHorizontal: 2,
  },
  switchOn: { backgroundColor: colors.primary },
  switchThumb: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff' },
  switchThumbOn: { transform: [{ translateX: 16 }] },
  mOption: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.surface,
  },
  mOptionOn: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  mOptionText: { flex: 1, fontSize: 14, color: colors.text, fontWeight: '700' },
  // Coord targets card (lat/lon/elev) — visible cuando measurement_type = coord_latlon
  coordCard: {
    marginTop: 12,
    borderWidth: 1, borderColor: colors.primary,
    backgroundColor: colors.primaryLight,
    borderRadius: radius.md, padding: 12, gap: 10,
  },
  coordHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  coordHeaderText: { fontSize: 12, fontWeight: '800', color: colors.primary, letterSpacing: 0.3, textTransform: 'uppercase' },
  coordHelp: { fontSize: 11, color: colors.textBody, lineHeight: 15 },
  coordRow: { flexDirection: 'row', gap: 10 },
  coordField: { flex: 1, gap: 6 },
  coordLabel: { fontSize: 11, fontWeight: '700', color: colors.textBody },
  errorBoxInline: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.errorBg, padding: 10, borderRadius: radius.md },
});
