export function formatMoney(n: number): string {
  return '$' + Number(n).toLocaleString('es-AR');
}

/** "+$1.000", "-$1.000" o "$0". */
export function formatSigned(n: number): string {
  return `${n > 0 ? '+' : ''}${formatMoney(n)}`;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Único parser de montos: acepta coma o punto decimal, y puntos de miles si
 * hay coma ("1.500,50"). Devuelve null si el texto no es un número válido.
 */
export function parseAmount(raw: string): number | null {
  let text = raw.trim();
  if (!text) return null;
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
