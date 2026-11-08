/** Fotos de cartas para la sala remota: se reducen en el celular antes de subirse. */

const MAX_SIDE = 1280;
const QUALITY = 0.72;

/**
 * Reduce una foto a un JPEG de hasta 1280 px de lado mayor (unos 150 KB) y devuelve su base64. Respeta la orientación
 * del celular y, al volver a dibujarla, deja afuera los datos EXIF (ubicación, modelo…).
 */
export async function resizeToJpeg(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No se pudo procesar la foto.');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('No se pudo procesar la foto.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
