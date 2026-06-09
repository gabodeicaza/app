import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert,
  TextInput, Modal, ActivityIndicator, Platform, KeyboardAvoidingView,
  Switch,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Calendar, LocaleConfig } from 'react-native-calendars';
import DateTimePicker from '@react-native-community/datetimepicker';
import { AppHeader } from '@/src/components/AppHeader';
import { Button } from '@/src/components/Button';
import { api } from '@/src/api';
import { useAuth } from '@/src/auth-context';
import { colors, radius, spacing, areaTone } from '@/src/theme';

LocaleConfig.locales['es'] = {
  monthNames: ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'],
  monthNamesShort: ['Ene.','Feb.','Mar.','Abr.','May.','Jun.','Jul.','Ago.','Sep.','Oct.','Nov.','Dic.'],
  dayNames: ['Domingo','Lunes','Martes','Mircoles','Jueves','Viernes','Sbado'],
  dayNamesShort: ['D','L','M','X','J','V','S'],
  today: 'Hoy',
};
LocaleConfig.defaultLocale = 'es';

interface Area { id: string; name: string; color: string }
interface EventDoc {
  id: string;
  title: string;
  description: string;
  date: string;
  location?: string | null;
  area?: string | null;
  areaName?: string | null;
  alert_at?: string | null;
  notify_all: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function toYMD(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmtDateTime(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function fmtTime(iso: string) {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
}

export function CalendarScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [events, setEvents] = useState<EventDoc[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string>(toYMD(new Date()));
  const [showModal, setShowModal] = useState(false);

  // Form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [location, setLocation] = useState('');
  const [eventDate, setEventDate] = useState<Date>(new Date());
  const [areaId, setAreaId] = useState<string | null>(null);
  const [alertEnabled, setAlertEnabled] = useState(true);
  const [alertDate, setAlertDate] = useState<Date>(new Date(Date.now() + 30 * 60 * 1000));
  const [showDatePicker, setShowDatePicker] = useState<null | 'event' | 'alert'>(null);
  const [showTimePicker, setShowTimePicker] = useState<null | 'event' | 'alert'>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [evs, ars] = await Promise.all([
        api.listEvents(),
        api.listAreas(),
      ]);
      setEvents(evs || []);
      setAreas(ars || []);
    } catch (e: any) {
      Alert.alert('Error al cargar', e?.message || 'Error');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const marked = useMemo(() => {
    const m: Record<string, any> = {};
    for (const e of events) {
      const d = e.date.slice(0, 10);
      const color = e.area ? (areas.find(a => a.id === e.area)?.color || colors.primary) : colors.primary;
      m[d] = m[d]
        ? { ...m[d], dots: [...(m[d].dots || []), { color }] }
        : { dots: [{ color }] };
    }
    m[selectedDate] = { ...(m[selectedDate] || {}), selected: true, selectedColor: colors.primary };
    return m;
  }, [events, areas, selectedDate]);

  const dayEvents = useMemo(() => {
    return events
      .filter((e) => e.date.slice(0, 10) === selectedDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [events, selectedDate]);

  function resetForm(initialDate?: Date) {
    const d = initialDate || new Date();
    setEditingId(null);
    setTitle('');
    setDesc('');
    setLocation('');
    setEventDate(d);
    setAreaId(null);
    setAlertEnabled(true);
    setAlertDate(new Date(d.getTime() - 30 * 60 * 1000));
  }

  function openCreate() {
    const init = new Date(selectedDate + 'T09:00:00');
    resetForm(init);
    setShowModal(true);
  }

  function openEdit(e: EventDoc) {
    setEditingId(e.id);
    setTitle(e.title);
    setDesc(e.description || '');
    setLocation(e.location || '');
    setEventDate(new Date(e.date));
    setAreaId(e.area || null);
    setAlertEnabled(!!e.alert_at);
    setAlertDate(e.alert_at ? new Date(e.alert_at) : new Date(Date.now() + 30*60*1000));
    setShowModal(true);
  }

  async function save() {
    const t = title.trim();
    if (!t) { Alert.alert('Falta ttulo', 'Ingresa un ttulo para el evento.'); return; }
    setSaving(true);
    const payload = {
      title: t,
      description: desc.trim(),
      date: eventDate.toISOString(),
      location: location.trim() || null,
      area: areaId,
      alert_at: alertEnabled ? alertDate.toISOString() : null,
      notify_all: true,
    };
    try {
      if (editingId) await api.updateEvent(editingId, payload);
      else await api.createEvent(payload);
      setShowModal(false);
      await load();
    } catch (e: any) {
      Alert.alert('No se pudo guardar', e?.message || 'Error');
    } finally { setSaving(false); }
  }

  function confirmDelete(e: EventDoc) {
    Alert.alert('Eliminar evento', `Eliminar  ${e.title} ?`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Eliminar', style: 'destructive', onPress: async () => {
        try { await api.deleteEvent(e.id); await load(); }
        catch (err: any) { Alert.alert('No se pudo eliminar', err?.message || 'Error'); }
      }},
    ]);
  }

  function canEdit(e: EventDoc) {
    return user?.role === 'coordinador' || e.createdBy === user?.id;
  }

  return (
    <View style={styles.flex}>
      <AppHeader title="Calendario" subtitle="Eventos del proyecto"
        right={
          <Pressable onPress={openCreate} hitSlop={8} style={styles.addBtn}>
            <Ionicons name="add" size={20} color="#fff" />
          </Pressable>
        }
      />
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.primary} size="large" /></View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
          <Calendar
            current={selectedDate}
            onDayPress={(d) => setSelectedDate(d.dateString)}
            markingType="multi-dot"
            markedDates={marked}
            theme={{
              backgroundColor: colors.bg,
              calendarBackground: colors.surface,
              selectedDayBackgroundColor: colors.primary,
              todayTextColor: colors.primary,
              arrowColor: colors.primary,
              monthTextColor: colors.text,
              textMonthFontWeight: '900',
              dayTextColor: colors.text,
            }}
          />

          <View style={styles.dayHead}>
            <Text style={styles.dayHeadTitle}>
              {new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              })}
            </Text>
            <Text style={styles.dayHeadCount}>{dayEvents.length} evento{dayEvents.length === 1 ? '' : 's'}</Text>
          </View>

          {dayEvents.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="calendar-outline" size={32} color={colors.textMuted} />
              <Text style={styles.emptyTxt}>Sin eventos este da</Text>
              <Button label="Agregar evento" onPress={openCreate}
                icon={<Ionicons name="add" size={16} color="#fff" />} />
            </View>
          ) : (
            dayEvents.map((e) => {
              const tone = areaTone(areas.find(a => a.id === e.area)?.color);
              return (
                <View key={e.id} style={[styles.eventCard, { borderLeftColor: areas.find(a => a.id === e.area)?.color || colors.primary }]}>
                  <View style={styles.eventHead}>
                    <Text style={styles.eventTime}>{fmtTime(e.date)}</Text>
                    <View style={[styles.eventTag, { backgroundColor: tone.bg, borderColor: tone.border }]}>
                      <Text style={[styles.eventTagTxt, { color: tone.text }]}>{e.areaName || 'Global'}</Text>
                    </View>
                    {canEdit(e) ? (
                      <View style={{ flexDirection: 'row', gap: 4, marginLeft: 'auto' }}>
                        <Pressable onPress={() => openEdit(e)} hitSlop={6} style={styles.iconAct}>
                          <Ionicons name="create-outline" size={16} color={colors.primary} />
                        </Pressable>
                        <Pressable onPress={() => confirmDelete(e)} hitSlop={6} style={styles.iconAct}>
                          <Ionicons name="trash-outline" size={16} color={colors.error} />
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.eventTitle}>{e.title}</Text>
                  {e.description ? <Text style={styles.eventDesc}>{e.description}</Text> : null}
                  {e.location ? (
                    <View style={styles.metaRow}>
                      <Ionicons name="location-outline" size={13} color={colors.textMuted} />
                      <Text style={styles.metaTxt}>{e.location}</Text>
                    </View>
                  ) : null}
                  <View style={styles.metaRow}>
                    <Ionicons name="person-outline" size={13} color={colors.textMuted} />
                    <Text style={styles.metaTxt}>{e.createdByName}</Text>
                  </View>
                  {e.alert_at ? (
                    <View style={styles.alertChip}>
                      <Ionicons name="notifications" size={12} color="#92400E" />
                      <Text style={styles.alertTxt}>Alerta: {fmtDateTime(e.alert_at)}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </ScrollView>
      )}

      {/* === Modal Crear/Editar === */}
      <Modal visible={showModal} animationType="slide" transparent onRequestClose={() => setShowModal(false)}>
        <View style={styles.backdrop}>
          <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.handle} />
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>{editingId ? 'Editar evento' : 'Nuevo evento'}</Text>
                <Pressable onPress={() => setShowModal(false)} hitSlop={8}>
                  <Ionicons name="close" size={22} color={colors.textBody} />
                </Pressable>
              </View>

              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: spacing.md }}>
                <View>
                  <Text style={styles.label}>Ttulo</Text>
                  <TextInput value={title} onChangeText={setTitle}
                    placeholder="Ej. Colado de losa K0+200"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                  />
                </View>

                <View>
                  <Text style={styles.label}>Descripcin</Text>
                  <TextInput value={desc} onChangeText={setDesc}
                    placeholder="Detalles, asistentes, materiales "
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                    multiline
                  />
                </View>

                <View>
                  <Text style={styles.label}>Fecha y hora del evento</Text>
                  <View style={styles.rowGap}>
                    <Pressable onPress={() => setShowDatePicker('event')} style={styles.dateBtn}>
                      <Ionicons name="calendar-outline" size={16} color={colors.primary} />
                      <Text style={styles.dateTxt}>
                        {eventDate.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => setShowTimePicker('event')} style={styles.dateBtn}>
                      <Ionicons name="time-outline" size={16} color={colors.primary} />
                      <Text style={styles.dateTxt}>
                        {pad(eventDate.getHours())}:{pad(eventDate.getMinutes())}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View>
                  <Text style={styles.label}>Ubicacin (opcional)</Text>
                  <TextInput value={location} onChangeText={setLocation}
                    placeholder="Tramo, frente, sitio "
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                  />
                </View>

                <View>
                  <Text style={styles.label}>rea</Text>
                  <View style={styles.chipsRow}>
                    <Pressable onPress={() => setAreaId(null)}
                      style={[styles.chip, areaId === null && { backgroundColor: colors.primary, borderColor: colors.primary }]}
                    >
                      <Ionicons name="globe-outline" size={13}
                        color={areaId === null ? '#fff' : colors.textBody} />
                      <Text style={[styles.chipLbl, areaId === null && { color: '#fff' }]}>Global</Text>
                    </Pressable>
                    {areas.map((a) => {
                      const sel = areaId === a.id;
                      const tone = areaTone(a.color);
                      return (
                        <Pressable key={a.id} onPress={() => setAreaId(a.id)}
                          style={[styles.chip, { backgroundColor: tone.bg, borderColor: tone.border },
                                  sel && { backgroundColor: a.color, borderColor: a.color }]}
                        >
                          <View style={[styles.chipDot, { backgroundColor: sel ? '#fff' : a.color }]} />
                          <Text style={[styles.chipLbl, { color: sel ? '#fff' : tone.text }]}>{a.name}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.alertBox}>
                  <View style={styles.alertHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.label}>Programar alerta</Text>
                      <Text style={styles.helper}>Aviso in-app para todos los usuarios visibles.</Text>
                    </View>
                    <Switch value={alertEnabled} onValueChange={setAlertEnabled}
                      trackColor={{ false: '#CBD5E1', true: colors.primary }}
                    />
                  </View>
                  {alertEnabled ? (
                    <View style={[styles.rowGap, { marginTop: 8 }]}>
                      <Pressable onPress={() => setShowDatePicker('alert')} style={styles.dateBtn}>
                        <Ionicons name="calendar-outline" size={16} color={colors.primary} />
                        <Text style={styles.dateTxt}>
                          {alertDate.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })}
                        </Text>
                      </Pressable>
                      <Pressable onPress={() => setShowTimePicker('alert')} style={styles.dateBtn}>
                        <Ionicons name="time-outline" size={16} color={colors.primary} />
                        <Text style={styles.dateTxt}>
                          {pad(alertDate.getHours())}:{pad(alertDate.getMinutes())}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>

                <Button label={editingId ? 'Guardar cambios' : 'Crear evento'}
                  onPress={save} loading={saving} fullWidth
                  icon={<Ionicons name="checkmark" size={16} color="#fff" />}
                />
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>

      {/* Date / Time pickers (Android only by default; iOS inline below if needed) */}
      {showDatePicker ? (
        <DateTimePicker
          value={showDatePicker === 'event' ? eventDate : alertDate}
          mode="date"
          onChange={(_, d) => {
            const target = showDatePicker;
            setShowDatePicker(null);
            if (d) {
              if (target === 'event') {
                const nd = new Date(eventDate);
                nd.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                setEventDate(nd);
              } else {
                const nd = new Date(alertDate);
                nd.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                setAlertDate(nd);
              }
            }
          }}
        />
      ) : null}
      {showTimePicker ? (
        <DateTimePicker
          value={showTimePicker === 'event' ? eventDate : alertDate}
          mode="time"
          onChange={(_, d) => {
            const target = showTimePicker;
            setShowTimePicker(null);
            if (d) {
              if (target === 'event') {
                const nd = new Date(eventDate);
                nd.setHours(d.getHours(), d.getMinutes(), 0, 0);
                setEventDate(nd);
              } else {
                const nd = new Date(alertDate);
                nd.setHours(d.getHours(), d.getMinutes(), 0, 0);
                setAlertDate(nd);
              }
            }
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  addBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: 6 },
  dayHeadTitle: { fontSize: 14, fontWeight: '900', color: colors.text, textTransform: 'capitalize', flex: 1 },
  dayHeadCount: { fontSize: 12, color: colors.textMuted, fontWeight: '700' },
  empty: { alignItems: 'center', padding: spacing.xl, gap: 10 },
  emptyTxt: { color: colors.textMuted, fontWeight: '700' },
  eventCard: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, borderLeftWidth: 4,
    margin: spacing.md, marginTop: 0, marginBottom: spacing.sm,
    padding: spacing.md, gap: 4,
  },
  eventHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eventTime: { fontSize: 12, color: colors.primary, fontWeight: '900' },
  eventTag: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  eventTagTxt: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase' },
  iconAct: { padding: 4 },
  eventTitle: { fontSize: 15, fontWeight: '900', color: colors.text, marginTop: 2 },
  eventDesc: { fontSize: 13, color: colors.textBody, lineHeight: 18 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  metaTxt: { fontSize: 12, color: colors.textMuted, flex: 1 },
  alertChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: '#FEF3C7', borderColor: '#FCD34D', borderWidth: 1,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start', marginTop: 4,
  },
  alertTxt: { color: '#92400E', fontSize: 11, fontWeight: '800' },

  backdrop: { flex: 1, backgroundColor: 'rgba(15,23,42,0.4)' },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: spacing.md, maxHeight: '92%' },
  handle: { alignSelf: 'center', width: 40, height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: spacing.sm },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  modalTitle: { fontSize: 18, fontWeight: '900', color: colors.text },
  label: { fontSize: 12, fontWeight: '700', color: colors.textBody, marginBottom: 6 },
  helper: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  input: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, color: colors.text, backgroundColor: colors.surface },
  rowGap: { flexDirection: 'row', gap: 8 },
  dateBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 11, backgroundColor: colors.surface },
  dateTxt: { color: colors.text, fontSize: 14, fontWeight: '700' },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.surface },
  chipLbl: { fontSize: 12, fontWeight: '700', color: colors.textBody },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  alertBox: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: spacing.md, backgroundColor: colors.bg },
  alertHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
});
