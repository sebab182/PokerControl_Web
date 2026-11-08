import { useEffect, useState } from 'react';

/** Preferencias de la mesa. Son de cada dispositivo: se guardan en localStorage. */
export interface TablePrefs {
  sound: boolean;
  vibrate: boolean;
  animations: boolean;
  keepAwake: boolean;
  /** Un sonido corto al empezar cada mano. */
  handSound: boolean;
  /** Ver los emojis de los demás y poder mandar los propios. */
  emojis: boolean;
  /**
   * Tipo de mazo. Con el clásico, tréboles y picas (los dos negros) se confunden: "four" pinta diamantes de azul y tréboles
   * de verde; "color" además pinta el fondo de cada carta con el color de su palo y agranda el número.
   */
  deck: Deck;
}

export const DECKS = ['classic', 'four', 'color'] as const;
export type Deck = typeof DECKS[number];

const KEY = 'pc_table_prefs';
const DEFAULTS: TablePrefs = { sound: true, vibrate: true, animations: true, keepAwake: true, handSound: true, emojis: true, deck: 'four' };

function load(): TablePrefs {
  try {
    const saved = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<TablePrefs>) };
    // Un valor que ya no existe (o guardado a mano) vuelve al mazo por defecto.
    return DECKS.includes(saved.deck) ? saved : { ...saved, deck: DEFAULTS.deck };
  } catch {
    return DEFAULTS;
  }
}

export function useTablePrefs() {
  const [prefs, setPrefs] = useState(load);
  const update = (patch: Partial<TablePrefs>) => setPrefs(prev => {
    const next = { ...prev, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* sin almacenamiento: vale para esta visita */ }
    return next;
  });
  return [prefs, update] as const;
}

let audio: AudioContext | null = null;

/** Tono corto. El navegador solo deja sonar después de un toque, así que puede no oírse la primera vez. */
function beep() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const t = audio.currentTime;
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  } catch { /* sin Web Audio */ }
}

const HAND_SOUND = `${import.meta.env.BASE_URL}sounds/hand-start.mp3`;
/** Duración máxima: suenan los primeros 5 s del archivo aunque se reemplace por uno más largo. */
const HAND_SOUND_MAX_MS = 5000;
let handAudio: HTMLAudioElement | null = null;
let handTimer: ReturnType<typeof setTimeout> | undefined;

function handAudioEl(): HTMLAudioElement {
  handAudio ??= new Audio(HAND_SOUND);
  handAudio.preload = 'auto';
  return handAudio;
}

/**
 * El navegador solo deja sonar después de un toque. Con el primero se "prepara" el audio en silencio, así la mano nueva
 * suena aunque quien mira no haya tocado nada desde entonces.
 */
export function primeHandSound(): void {
  const a = handAudioEl();
  a.muted = true;
  a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
}

/** Suena el aviso de mano nueva (los primeros 5 s del archivo). Sin permiso del navegador, no hace nada. */
export function playHandStart(): void {
  try {
    const a = handAudioEl();
    clearTimeout(handTimer);
    a.muted = false;
    a.currentTime = 0;
    a.volume = 0.7;
    a.play().catch(() => {});
    handTimer = setTimeout(() => a.pause(), HAND_SOUND_MAX_MS);
  } catch { /* sin audio */ }
}

/** Aviso al pasar a tener el turno: sonido y vibración, según las preferencias. */
export function useTurnAlert(myTurn: boolean, prefs: TablePrefs) {
  useEffect(() => {
    if (!myTurn) return;
    if (prefs.vibrate) navigator.vibrate?.(180);
    if (prefs.sound) beep();
    // Solo al empezar el turno: cambiar una preferencia en medio no vuelve a avisar.
  }, [myTurn]);
}

/** Mantiene la pantalla encendida mientras `active`. El navegador lo suelta al ocultar la pestaña: se pide de nuevo al volver. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let done = false;
    const request = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen')
        .then(l => { if (done) void l.release(); else lock = l; })
        .catch(() => {});
    };
    request();
    document.addEventListener('visibilitychange', request);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', request);
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
