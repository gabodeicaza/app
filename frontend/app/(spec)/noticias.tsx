// SynCo v2.0 — Tab Noticias (placeholder con look consistente).
import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { ComingSoon } from '@/src/components/ComingSoon';

export default function NoticiasScreen() {
  return (
    <ComingSoon
      icon={(<Ionicons name="newspaper" size={36} color="#fff" />)}
      title="Noticias del proyecto"
      subtitle="Aquí verás anuncios del Coordinador y actualizaciones del contrato."
      tag="Próximamente"
    />
  );
}
