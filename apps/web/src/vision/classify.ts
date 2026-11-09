import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import mjsUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import wasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import { CORNER_H, CORNER_W, type CardBox } from './detect';

const RANKS = 'A23456789TJQK';
const SUITS = 'shdc';
export const MODEL_URL = `${import.meta.env.BASE_URL}models/card-corner.onnx`;

type Ort = typeof import('onnxruntime-web/wasm');
let loading: Promise<{ ort: Ort; session: InferenceSession }> | null = null;

/** Carga perezosa del motor (WASM, ~11 MB) y del modelo; solo la usa la pantalla de prueba. */
function engine() {
  loading ??= (async () => {
    const ort = await import('onnxruntime-web/wasm');
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = { mjs: mjsUrl, wasm: wasmUrl };
    const session = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] });
    return { ort, session };
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export const preload = (): Promise<unknown> => engine();

export interface Reading {
  /** Código de carta, p. ej. "As" o "Td". */
  card: string;
  /** Confianza combinada de valor y palo (0..1). */
  confidence: number;
  rank: string;
  suit: string;
  /** Esquina que dio la lectura: 0 = arriba-izquierda, 1 = abajo-derecha. */
  corner: 0 | 1;
}

function softmax(v: ArrayLike<number>, from: number, n: number): number[] {
  let m = -Infinity;
  for (let i = 0; i < n; i++) m = Math.max(m, v[from + i]);
  const e = Array.from({ length: n }, (_, i) => Math.exp(v[from + i] - m));
  const s = e.reduce((x, y) => x + y, 0);
  return e.map(x => x / s);
}

/** Lee cada carta detectada: clasifica sus dos esquinas y se queda con la más segura. */
export async function readCards(boxes: CardBox[]): Promise<Reading[]> {
  if (!boxes.length) return [];
  const { ort, session } = await engine();
  const n = boxes.length * 2;
  const plane = 3 * CORNER_W * CORNER_H;
  const input = new Float32Array(n * plane);
  boxes.forEach((b, i) => { input.set(b.crops[0], i * 2 * plane); input.set(b.crops[1], (i * 2 + 1) * plane); });
  const out = await session.run({ x: new ort.Tensor('float32', input, [n, 3, CORNER_H, CORNER_W]) });
  const rk = (out.rank as Tensor).data as Float32Array, st = (out.suit as Tensor).data as Float32Array;
  return boxes.map((_, i) => {
    let best: Reading | null = null;
    for (const c of [0, 1] as const) {
      const row = i * 2 + c;
      const pr = softmax(rk, row * 13, 13), ps = softmax(st, row * 4, 4);
      const ri = pr.indexOf(Math.max(...pr)), si = ps.indexOf(Math.max(...ps));
      const confidence = pr[ri] * ps[si];
      if (!best || confidence > best.confidence) best = { card: RANKS[ri] + SUITS[si], confidence, rank: RANKS[ri], suit: SUITS[si], corner: c };
    }
    return best as Reading;
  });
}
