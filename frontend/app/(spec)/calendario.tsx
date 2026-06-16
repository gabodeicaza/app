// SynCo v2.0 — Tab Calendario (placeholder).
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ComingSoon } from '@/src/components/ComingSoon';

export default function CalendarioScreen() {
  return (
    <ComingSoon
      icon={(<Ionicons name="calendar" size={36} color="#fff" />)}
      title="Calendario compartido"
      subtitle="Programación de actividades, hitos del contrato y recordatorios."
      tag="Próximamente"
    />
  );
}
