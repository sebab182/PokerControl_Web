/**
 * Detección de cartas por visión clásica: las cartas son manchas claras sobre la mesa. Se umbraliza (Otsu), se agrupan
 * los píxeles conectados, se calcula el rectángulo de menor área de cada mancha y, si tiene proporción de carta, se
 * recortan sus dos esquinas de índice (arriba-izquierda y abajo-derecha) para el clasificador.
 */

export const CORNER_W = 40;
export const CORNER_H = 56;
/** Parte del ancho y del alto de la carta que abarca la esquina del índice (igual que en el entrenamiento). */
export const CORNER_FRAC_W = 0.34;
export const CORNER_FRAC_H = 0.4;

export interface Pt { x: number; y: number }
export interface CardBox {
  /** Esquinas del rectángulo en coordenadas de la imagen original. */
  corners: Pt[];
  center: Pt;
  /** Dos esquinas listas para clasificar: [arriba-izquierda, abajo-derecha], NCHW 3x56x40 en 0..1. */
  crops: [Float32Array, Float32Array];
}

const WORK_MAX = 320;

function otsu(hist: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sumB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function polyArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a) / 2;
}

function hull(points: Pt[]): Pt[] {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Rectángulo de menor área que envuelve el casco: centro, ejes unitarios y semiextensiones. */
function minAreaRect(h: Pt[]): { c: Pt; a: Pt; b: Pt; ha: number; hb: number; area: number } | null {
  let best: { c: Pt; a: Pt; b: Pt; ha: number; hb: number; area: number } | null = null;
  for (let i = 0; i < h.length; i++) {
    const p = h[i], q = h[(i + 1) % h.length];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-6) continue;
    const a = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
    const b = { x: -a.y, y: a.x };
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const r of h) {
      const u = r.x * a.x + r.y * a.y, v = r.x * b.x + r.y * b.y;
      if (u < minA) minA = u; if (u > maxA) maxA = u;
      if (v < minB) minB = v; if (v > maxB) maxB = v;
    }
    const area = (maxA - minA) * (maxB - minB);
    if (!best || area < best.area) {
      const mu = (minA + maxA) / 2, mv = (minB + maxB) / 2;
      best = { c: { x: mu * a.x + mv * b.x, y: mu * a.y + mv * b.y }, a, b, ha: (maxA - minA) / 2, hb: (maxB - minB) / 2, area };
    }
  }
  return best;
}

/** Muestrea la esquina de la carta (origen `o`, ejes `u` y `v` ya escalados al tamaño completo) con interpolación bilineal. */
function sampleCorner(src: ImageData, o: Pt, u: Pt, v: Pt): Float32Array {
  const out = new Float32Array(3 * CORNER_W * CORNER_H);
  const { data, width, height } = src;
  const plane = CORNER_W * CORNER_H;
  for (let y = 0; y < CORNER_H; y++) {
    const t = ((y + 0.5) / CORNER_H) * CORNER_FRAC_H;
    for (let x = 0; x < CORNER_W; x++) {
      const s = ((x + 0.5) / CORNER_W) * CORNER_FRAC_W;
      const px = o.x + u.x * s + v.x * t, py = o.y + u.y * s + v.y * t;
      const x0 = Math.max(0, Math.min(width - 2, Math.floor(px))), y0 = Math.max(0, Math.min(height - 2, Math.floor(py)));
      const fx = Math.max(0, Math.min(1, px - x0)), fy = Math.max(0, Math.min(1, py - y0));
      const i00 = (y0 * width + x0) * 4, i10 = i00 + 4, i01 = i00 + width * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = data[i00 + ch] * (1 - fx) + data[i10 + ch] * fx;
        const bot = data[i01 + ch] * (1 - fx) + data[i11 + ch] * fx;
        out[ch * plane + y * CORNER_W + x] = (top * (1 - fy) + bot * fy) / 255;
      }
    }
  }
  return out;
}

export interface DetectOptions {
  /** Mínimo de área de la mancha como fracción del cuadro. */
  minArea?: number;
  maxArea?: number;
}

export function detectCards(src: ImageData, opts: DetectOptions = {}): CardBox[] {
  const minArea = opts.minArea ?? 0.012;
  const maxArea = opts.maxArea ?? 0.8;
  const k = Math.min(1, WORK_MAX / Math.max(src.width, src.height));
  const w = Math.max(8, Math.round(src.width * k)), h = Math.max(8, Math.round(src.height * k));
  const gray = new Uint8Array(w * h);
  const hist = new Array<number>(256).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (Math.min(src.height - 1, Math.floor(y / k)) * src.width + Math.min(src.width - 1, Math.floor(x / k))) * 4;
      const g = (src.data[i] * 77 + src.data[i + 1] * 150 + src.data[i + 2] * 29) >> 8;
      gray[y * w + x] = g;
      hist[g]++;
    }
  }
  const thr = Math.max(90, otsu(hist, w * h));
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = gray[i] > thr ? 1 : 0;

  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const found: CardBox[] = [];
  const cands: { rect: NonNullable<ReturnType<typeof minAreaRect>>; area: number; count: number }[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pts: Pt[] = [];
    let count = 0;
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const p = stack.pop() as number;
      count++;
      const x = p % w, y = (p - x) / w;
      // Solo los píxeles del borde alimentan el casco (con eso alcanza y es más barato).
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) pts.push({ x, y });
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    const hl = hull(pts);
    const hullArea = polyArea(hl);
    if (hullArea / (w * h) < minArea || hullArea / (w * h) > maxArea) continue;
    const rect = minAreaRect(hl);
    if (!rect) continue;
    const long = Math.max(rect.ha, rect.hb), short = Math.min(rect.ha, rect.hb);
    const ratio = short / long;
    // Una carta mide 63x88 mm (0,716). Se admite un margen por perspectiva y por borde recortado. La solidez se mide con el
    // casco convexo (no con los píxeles) porque el dibujo de la carta puede partir la mancha clara en un marco y un interior.
    if (ratio < 0.58 || ratio > 0.86 || hullArea / rect.area < 0.85) continue;
    cands.push({ rect, area: rect.area, count });
  }
  // De mayor a menor: lo que cae dentro de una carta ya aceptada es dibujo de esa carta, no otra carta.
  cands.sort((p, q) => q.area - p.area);
  const kept: typeof cands = [];
  for (const cd of cands) {
    const inside = kept.some(k => {
      const dx = cd.rect.c.x - k.rect.c.x, dy = cd.rect.c.y - k.rect.c.y;
      return Math.abs(dx * k.rect.a.x + dy * k.rect.a.y) < k.rect.ha && Math.abs(dx * k.rect.b.x + dy * k.rect.b.y) < k.rect.hb;
    });
    if (!inside) kept.push(cd);
  }
  for (const { rect } of kept) {
    const long = Math.max(rect.ha, rect.hb), short = Math.min(rect.ha, rect.hb);
    // Eje corto `a` (ancho) y eje largo `b` (alto), con orientación directa (como las agujas del reloj desde arriba-izquierda).
    const a = rect.ha <= rect.hb ? rect.a : rect.b;
    let b = rect.ha <= rect.hb ? rect.b : rect.a;
    if (a.x * b.y - a.y * b.x < 0) b = { x: -b.x, y: -b.y };
    const hs = short, hl2 = long;
    const c = rect.c;
    const toFull = (p: Pt): Pt => ({ x: p.x / k, y: p.y / k });
    const corner = (sa: number, sb: number): Pt => toFull({ x: c.x + a.x * hs * sa + b.x * hl2 * sb, y: c.y + a.y * hs * sa + b.y * hl2 * sb });
    const tl = corner(-1, -1), br = corner(1, 1);
    const u = { x: (a.x * 2 * hs) / k, y: (a.y * 2 * hs) / k }, v = { x: (b.x * 2 * hl2) / k, y: (b.y * 2 * hl2) / k };
    found.push({
      corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)],
      center: toFull(c),
      crops: [sampleCorner(src, tl, u, v), sampleCorner(src, br, { x: -u.x, y: -u.y }, { x: -v.x, y: -v.y })],
    });
  }
  return found;
}
