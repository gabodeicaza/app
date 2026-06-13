// Diccionario de coordenadas (mock) para postes del Cablebús (CDMX).
// Genera Lat/Lng deterministas por Tramo / Estación / Poste siguiendo
// una traza aproximada sobre la CDMX (sin almacenar nada en disco).
//
// Es una utilidad pura: NO toca AsyncStorage, NO toca FileSystem.
// Cumple "Cero Huella Local".

// Punto base CDMX (cercano al centro Iztapalapa - Tepito).
const BASE_LAT = 19.4326;
const BASE_LNG = -99.1332;

// Desfases aproximados por tramo (en grados).
//  - Tramo 1: corre hacia el sur-oriente
//  - Tramo 2: corre hacia el nor-oriente
const TRAMO_OFFSETS: Record<number, { lat: number; lng: number }> = {
  1: { lat: -0.025, lng: 0.018 },
  2: { lat: 0.022, lng: 0.030 },
};

// Cada estación se separa ~600 m sobre la traza.
const STATION_STEP = 0.0055;

// Cada poste dentro de una estación se separa ~28 m.
const POSTE_STEP = 0.00025;

export interface PosteCoord {
  lat: number;
  lng: number;
  /** Formato lectura humana, p.ej. "19.4216°N, 99.1108°W". */
  label: string;
  /** Identificador legible Cablebús. */
  id: string;
}

function fmt(lat: number, lng: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns}, ${Math.abs(lng).toFixed(4)}°${ew}`;
}

/**
 * Devuelve coordenadas mock CDMX para un poste Cablebús dado.
 * Si falta alguno de los parámetros, retorna `null`.
 */
export function getPosteCoord(
  tramo: 1 | 2 | null | undefined,
  estacion: number | null | undefined,
  poste: number | null | undefined,
): PosteCoord | null {
  if (!tramo || !estacion || !poste) return null;
  const off = TRAMO_OFFSETS[tramo] ?? TRAMO_OFFSETS[1];
  // Dirección perpendicular al tramo para distribuir postes "a lo ancho".
  const sign = tramo === 1 ? 1 : -1;
  const lat =
    BASE_LAT +
    off.lat +
    estacion * STATION_STEP * (tramo === 1 ? -1 : 1) +
    poste * POSTE_STEP * sign * 0.4;
  const lng =
    BASE_LNG +
    off.lng +
    estacion * STATION_STEP * 0.6 +
    poste * POSTE_STEP * sign;
  return {
    lat: Math.round(lat * 10000) / 10000,
    lng: Math.round(lng * 10000) / 10000,
    label: fmt(lat, lng),
    id: `T${tramo}-E${estacion}-P${poste}`,
  };
}

/** Nombre humano del segmento (para mostrar como "Ubicación" automática). */
export function posteLocationName(
  tramo: 1 | 2 | null | undefined,
  estacion: number | null | undefined,
  poste: number | null | undefined,
): string {
  if (!tramo || !estacion || !poste) return '';
  return `Cablebús Tramo ${tramo} · Estación ${estacion} · Poste ${poste}`;
}
