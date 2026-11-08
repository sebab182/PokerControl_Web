import type { ApiEmojiServerMessage } from '@pokercontrol/contracts';
import { TABLE_EMOJIS, type TableEmojiId } from '@pokercontrol/contracts/emojis';
import type { AnimationItem } from 'lottie-web';
import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react';
import { playSfx } from '../sounds';

/**
 * Emojis animados de la mesa. Las animaciones son de Noto Emoji Animation (Google) y se cargan desde su CDN
 * cuando se usan: no se copian al repo. Mientras carga (o si no carga, sin red o bloqueado) se ve el emoji común
 * con una animación de CSS, así que mandar uno nunca falla.
 */
export const emojiUrl = (id: string) => `https://fonts.gstatic.com/s/e/notoemoji/latest/${id}/lottie.json`;

const BY_ID = new Map<string, (typeof TABLE_EMOJIS)[number]>(TABLE_EMOJIS.map(e => [e.id, e]));
/** Cuántos pueden verse a la vez: con más, el más viejo se va. */
const MAX_FLOATING = 8;
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Una animación Lottie; sin movimiento reducido, mientras carga y si falla, se ve el emoji común. */
function LottieEmoji({ id, char }: { id: string; char: string }) {
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (reducedMotion()) return;
    let cancelled = false;
    let anim: AnimationItem | undefined;
    // El reproductor (unos 50 KB comprimidos) se descarga recién con el primer emoji.
    void import('lottie-web/build/player/lottie_light').then(({ default: lottie }) => {
      if (cancelled || !host.current) return;
      anim = lottie.loadAnimation({ container: host.current, renderer: 'svg', loop: true, autoplay: true, path: emojiUrl(id) });
      anim.addEventListener('DOMLoaded', () => { if (!cancelled) setReady(true); });
    }).catch(() => { /* queda el emoji común */ });
    return () => { cancelled = true; anim?.destroy(); };
  }, [id]);
  return (
    <span className="emoji-anim" data-ready={ready} aria-hidden="true">
      <span ref={host} className="emoji-lottie" />
      <span className="emoji-glyph">{char}</span>
    </span>
  );
}

interface Floating { key: number; id: string; char: string; name: string; x: number; y: number; dx: number }
let sequence = 0;

/** Desde dónde sale: el asiento de quien lo manda; si no está en la mesa, desde el botón de emojis. */
function anchorOf(playerId: string | null): { x: number; y: number } {
  const seat = playerId ? document.querySelector<HTMLElement>(`[data-player="${playerId.replace(/["\\]/g, '')}"]`) : null;
  const el = seat ?? document.querySelector<HTMLElement>('[data-emoji-fab]');
  const rect = el?.getBoundingClientRect();
  const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 44;
  const y = rect ? (seat ? rect.top + rect.height * 0.3 : rect.top) : window.innerHeight - 90;
  return { x: Math.min(Math.max(x, 48), window.innerWidth - 48), y: Math.max(y, 56) };
}

/**
 * Capa donde flotan los emojis recibidos, por encima de la mesa y sin tapar toques. `handler` lo llama el socket
 * con cada emoji; `enabled` apaga la capa si el usuario silenció los emojis.
 */
export function EmojiLayer({ handler, enabled, sound = false }: { handler: MutableRefObject<(m: ApiEmojiServerMessage) => void>; enabled: boolean; sound?: boolean }) {
  const [floats, setFloats] = useState<Floating[]>([]);
  const [said, setSaid] = useState('');
  handler.current = m => {
    const emoji = BY_ID.get(m.id);
    if (!enabled || !emoji) return;
    const at = anchorOf(m.playerId);
    // Cada emoji tiene su efecto (public/sounds/emoji/<código>.mp3).
    if (sound) playSfx(`emoji:${emoji.id}`, { volume: 0.7 });
    setFloats(prev => [...prev.slice(1 - MAX_FLOATING), { key: ++sequence, id: emoji.id, char: emoji.char, name: m.name, ...at, dx: Math.round(Math.random() * 40 - 20) }]);
    setSaid(`${m.name} envió ${emoji.label}`);
  };
  return (
    <>
      <div className="emoji-layer" aria-hidden="true">
        {floats.map(f => (
          <div key={f.key} className="emoji-float" data-testid="emoji-float" style={{ left: f.x, top: f.y, '--dx': `${f.dx}px` } as CSSProperties}
            onAnimationEnd={e => { if (e.target === e.currentTarget) setFloats(prev => prev.filter(x => x.key !== f.key)); }}>
            <LottieEmoji id={f.id} char={f.char} />
            <span className="emoji-name">{f.name}</span>
          </div>
        ))}
      </div>
      {/* Lo mismo, para lectores de pantalla. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="emoji-said">{said}</p>
    </>
  );
}

/**
 * Botón flotante que centraliza los emojis: abre una paleta fija y manda el elegido. En el paño va en la esquina de
 * abajo a la derecha (fuera de los asientos y de las acciones); en la sala de espera, flotando sobre la página.
 */
export function EmojiFab({ placement, live, onSend }: { placement: 'felt' | 'page'; live: boolean; onSend: (id: TableEmojiId) => void }) {
  const [open, setOpen] = useState(false);
  const [cooling, setCooling] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (id: TableEmojiId) => {
    onSend(id);
    setOpen(false);
    // El servidor deja pasar uno cada ~1,5 s: el botón descansa lo mismo.
    setCooling(true);
    timer.current = setTimeout(() => setCooling(false), 1500);
  };
  return (
    <div className={`emoji-fab emoji-fab-${placement}`} ref={ref}>
      <button type="button" className="emoji-fab-btn" data-emoji-fab aria-label="Enviar un emoji" aria-expanded={open} aria-controls="emoji-palette"
        disabled={!live || cooling} title={live ? 'Enviar un emoji' : 'Hace falta la conexión en vivo'} onClick={() => setOpen(o => !o)}>
        <span aria-hidden="true">😊</span>
      </button>
      {open && (
        <div id="emoji-palette" className="emoji-palette" role="group" aria-label="Emojis">
          {TABLE_EMOJIS.map(e => (
            <button type="button" key={e.id} className="emoji-pick" aria-label={e.label}
              // Se empieza a bajar la animación al tocar, antes del click: llega lista cuando se manda.
              onPointerDown={() => { void fetch(emojiUrl(e.id)).catch(() => {}); }} onClick={() => pick(e.id)}>
              <span aria-hidden="true">{e.char}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
