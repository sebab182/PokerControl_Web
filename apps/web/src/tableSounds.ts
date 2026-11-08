import type { ApiTableView } from '@pokercontrol/contracts';
import { playsHandStartSound } from '@pokercontrol/core';
import { useEffect, useRef } from 'react';
import { playSfx } from './sounds';
import { playHandStart, type TablePrefs } from './tablePrefs';

/** Segundos finales del turno en que suena el tic-tac. */
export const TICK_SECONDS = 5;

interface Seen {
  handNo: number | null;
  fold: string;
  shown: Map<string, number>;
  /** El aviso de mano nueva sonó en la mano anterior. */
  jingle: boolean;
}

/**
 * Sonidos que salen de lo que pasa en la mesa, comparando una vista con la anterior: mezclar y repartir al empezar la
 * mano, el aviso de mano nueva (la primera siempre y después de vez en cuando), retirarse y mostrar cartas. Lo que ya
 * estaba al abrir la página no suena.
 */
export function useTableSounds(view: ApiTableView | undefined, prefs: TablePrefs) {
  const seen = useRef<Seen | null>(null);
  const latest = useRef(prefs);
  latest.current = prefs;

  useEffect(() => {
    if (!view) return;
    const hand = view.hand;
    const shown = new Map((hand?.players ?? []).map(p => [p.playerId, p.shown.length]));
    const fold = hand?.lastAction?.type === 'fold' ? `${hand.handNo}|${hand.lastAction.playerId}` : '';
    const before = seen.current;
    if (!before) {
      seen.current = { handNo: hand?.handNo ?? null, fold, shown, jingle: false };
      return;
    }
    const p = latest.current;
    if (hand && hand.handNo !== before.handNo) {
      // Mano nueva: se mezcla, se reparte (una carta por jugador) y, a veces, suena el aviso.
      if (p.sound) {
        playSfx('shuffle');
        hand.players.forEach((_, i) => playSfx('deal', { delayMs: 650 + i * 150, volume: 0.6 }));
      }
      const jingle = playsHandStartSound({ gameHandNo: hand.gameHandNo, previousPlayed: before.jingle });
      if (jingle && p.handSound) playHandStart();
      seen.current = { handNo: hand.handNo, fold, shown, jingle };
      return;
    }
    if (hand && p.sound) {
      if (fold && fold !== before.fold) playSfx('fold');
      if ([...shown].some(([id, n]) => n > (before.shown.get(id) ?? 0))) playSfx('show');
    }
    seen.current = { ...before, handNo: hand?.handNo ?? before.handNo, fold, shown };
  }, [view]);
}

/** Tic-tac en los últimos segundos del turno de quien tiene que decidir: alterna tic y toc, uno por segundo. */
export function useTickTock(secondsLeft: number, active: boolean, enabled: boolean) {
  useEffect(() => {
    if (!active || !enabled || secondsLeft <= 0 || secondsLeft > TICK_SECONDS) return;
    playSfx(secondsLeft % 2 === 0 ? 'tick' : 'tock', { volume: 0.7 });
  }, [secondsLeft, active, enabled]);
}
