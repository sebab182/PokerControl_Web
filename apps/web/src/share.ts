/** Comparte con navigator.share; si no hay, abre WhatsApp; si no, copia al portapapeles. */
export async function shareText(text: string, notify: (message: string) => void): Promise<void> {
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
    }
  }
  const opened = window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  // Con noopener, window.open devuelve null aunque abra: copiar también cubre al navegador que lo bloquea.
  try {
    await navigator.clipboard.writeText(text);
    notify(opened ? 'Abierto en WhatsApp. También se copió el texto.' : 'Texto copiado al portapapeles.');
  } catch {
    if (!opened) notify('No se pudo compartir ni copiar el texto.');
  }
}
