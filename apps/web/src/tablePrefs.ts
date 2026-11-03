import { useEffect, useState } from 'react';

/** Preferencias de la mesa. Son de cada dispositivo: se guardan en localStorage. */
export interface TablePrefs {
  sound: boolean;
  vibrate: boolean;
  animations: boolean;
  keepAwake: boolean;
}

const KEY = 'pc_table_prefs';
const DEFAULTS: TablePrefs = { sound: true, vibrate: true, animations: true, keepAwake: true };

function load(): TablePrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<TablePrefs>) };
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
