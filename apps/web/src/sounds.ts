/**
 * Efectos de sonido de la mesa. Cada archivo (apps/web/public/sounds) se descarga recién la primera vez que suena y se
 * guarda decodificado, así se oye sin demora y se pueden superponer. Créditos y licencias en public/sounds/LICENSE.txt.
 */

const BASE = import.meta.env.BASE_URL;
/** Cuántos efectos pueden sonar a la vez: más se pisan y quedan en barullo. */
const MAX_AT_ONCE = 4;

/** Variantes de cada efecto: si hay varias, suena una al azar. */
const FILES: Record<string, string[]> = {
  shuffle: ['shuffle'],
  deal: ['deal-1', 'deal-2', 'deal-3', 'deal-4'],
  fold: ['fold'],
  show: ['show'],
  tick: ['tick'],
  tock: ['tock'],
};

export type Sfx = 'shuffle' | 'deal' | 'fold' | 'show' | 'tick' | 'tock' | `emoji:${string}`;

let ctx: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let active = 0;

/** El único AudioContext de la página. Puede no existir (navegadores sin Web Audio). */
export function audioContext(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

/** Con el primer toque del usuario el navegador permite sonar: se reanuda el contexto. */
export function unlockAudio(): void {
  void audioContext()?.resume().catch(() => {});
}

function urlOf(id: Sfx): string {
  if (id.startsWith('emoji:')) return `${BASE}sounds/emoji/${id.slice(6)}.mp3`;
  const variants = FILES[id] ?? [id];
  return `${BASE}sounds/${variants[Math.floor(Math.random() * variants.length)]}.mp3`;
}

function load(url: string, audio: AudioContext): Promise<AudioBuffer | null> {
  let b = buffers.get(url);
  if (!b) {
    b = fetch(url)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(data => audio.decodeAudioData(data))
      .catch(() => null);
    buffers.set(url, b);
  }
  return b;
}

/** En desarrollo anota cada efecto pedido (lo leen los tests e2e). */
function trace(id: Sfx): void {
  if (!import.meta.env.DEV) return;
  const w = window as unknown as { __sfx?: string[] };
  (w.__sfx ??= []).push(id);
}

/** Reproduce un efecto. Sin permiso del navegador o sin el archivo, no pasa nada. */
export function playSfx(id: Sfx, opts: { volume?: number; delayMs?: number } = {}): void {
  trace(id);
  const audio = audioContext();
  if (!audio) return;
  const start = () => {
    if (active >= MAX_AT_ONCE) return;
    void load(urlOf(id), audio).then(buffer => {
      if (!buffer || audio.state !== 'running') return;
      const src = audio.createBufferSource();
      const gain = audio.createGain();
      gain.gain.value = opts.volume ?? 0.8;
      src.buffer = buffer;
      src.connect(gain).connect(audio.destination);
      active++;
      src.onended = () => { active = Math.max(0, active - 1); };
      src.start();
    });
  };
  if (opts.delayMs) setTimeout(start, opts.delayMs);
  else start();
}
