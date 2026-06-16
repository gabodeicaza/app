// SynCo v2.0 — Tab Mensajes (placeholder).
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ComingSoon } from '@/src/components/ComingSoon';

export default function MensajesScreen() {
  return (
    <ComingSoon
      icon={(<Ionicons name="chatbubbles" size={36} color="#fff" />)}
      title="Mensajes del equipo"
      subtitle="Conversaciones por área y por nodo de obra. Llegará en la próxima fase."
      tag="Próximamente"
    />
  );
}
