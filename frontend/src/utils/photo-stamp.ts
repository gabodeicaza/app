// Cero Huella Local: la metadata viaja con la foto pero nunca se persiste fuera de RAM.
import * as Location from 'expo-location';

export interface PhotoStampMeta {
  coordinates: string;   // "lat, lon" o "Sin GPS"
  date: string;          // dd/mm/yyyy
  time: string;          // HH:MM
  weather: string;       // simulado
  app: string;           // "SynCo"
}

const WEATHERS = [
  'Soleado 24C',
  'Despejado 22C',
  'Nublado 19C',
  'Parc. nublado 21C',
  'Llovizna ligera 17C',
  'Vientos mod. 20C',
];

function pad(n: number) { return n < 10 ? `0${n}` : `${n}`; }

export async function buildStampMeta(): Promise<PhotoStampMeta> {
  let coords = 'Sin GPS';
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    let granted = perm.status === 'granted';
    if (!granted && perm.canAskAgain) {
      const ask = await Location.requestForegroundPermissionsAsync();
      granted = ask.status === 'granted';
    }
    if (granted) {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      coords = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
    }
  } catch {
    // ignore
  }
  const now = new Date();
  const date = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const weather = WEATHERS[Math.floor(Math.random() * WEATHERS.length)];
  return { coordinates: coords, date, time, weather, app: 'SynCo' };
}
