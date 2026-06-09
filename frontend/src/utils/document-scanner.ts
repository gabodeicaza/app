import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import * as FileSystem from 'expo-file-system/legacy';

async function wipe(uri?: string | null) {
  if (!uri || !uri.startsWith('file:')) return;
  try { await FileSystem.deleteAsync(uri, { idempotent: true }); } catch {}
}

/**
 * Lanza la c mara, mejora la imagen (escala de grises + contraste) y
 * empaqueta el resultado en un PDF en RAM. Devuelve un objeto listo para
 * adjuntarse a un reporte; no escribe nada en la galera (Cero Huella Local).
 */
export async function scanDocumentToPdf(): Promise<
  { name: string; mimeType: string; dataUrl: string } | null
> {
  const perm = await ImagePicker.getCameraPermissionsAsync();
  let granted = perm.status === 'granted';
  if (!granted && perm.canAskAgain) {
    const ask = await ImagePicker.requestCameraPermissionsAsync();
    granted = ask.status === 'granted';
  }
  if (!granted) throw new Error('Permiso de c mara denegado');

  const result = await ImagePicker.launchCameraAsync({
    base64: true,
    quality: 0.9,
    exif: false,
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
  });
  if (result.canceled) return null;
  const a = result.assets[0];
  if (!a?.uri) return null;

  // Mejora: encoger a 1600px y aplicar resampling fuerte (mejora legibilidad en PDF).
  let processedUri = a.uri;
  try {
    const manip = await ImageManipulator.manipulateAsync(
      a.uri,
      [{ resize: { width: 1600 } }],
      { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
    void wipe(a.uri);
    processedUri = manip.uri;
    // Construir PDF carta tama o desde la imagen.
    const imgB64 = manip.base64 || (await FileSystem.readAsStringAsync(manip.uri, { encoding: 'base64' }));
    const html = `
      <!DOCTYPE html>
      <html><head>
        <meta charset="utf-8" />
        <style>
          @page { size: Letter; margin: 0; }
          html, body { margin: 0; padding: 0; }
          body { display: flex; align-items: center; justify-content: center;
                 background: #fff; min-height: 100vh; }
          img { max-width: 100%; max-height: 100vh; filter: grayscale(100%) contrast(115%); }
        </style>
      </head><body>
        <img src="data:image/jpeg;base64,${imgB64}" />
      </body></html>`;
    const { uri: pdfUri } = await Print.printToFileAsync({ html, base64: false });
    const pdfB64 = await FileSystem.readAsStringAsync(pdfUri, { encoding: 'base64' });
    void wipe(pdfUri);
    void wipe(processedUri);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return {
      name: `documento-${ts}.pdf`,
      mimeType: 'application/pdf',
      dataUrl: `data:application/pdf;base64,${pdfB64}`,
    };
  } catch (e) {
    void wipe(a.uri);
    void wipe(processedUri);
    throw e;
  }
}
