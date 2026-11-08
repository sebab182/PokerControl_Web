/** Cuándo suena el aviso de «mano nueva»: siempre en la primera mano de la partida y después de vez en cuando. */

/** Probabilidad de que suene en una mano que no es la primera. */
export const HAND_SOUND_CHANCE = 0.15;

/**
 * ¿Suena el aviso en esta mano? La primera mano de la partida siempre; las siguientes al azar (`HAND_SOUND_CHANCE`) y
 * nunca dos seguidas, para que no se repita en cada mano. `random` devuelve un número en [0, 1).
 */
export function playsHandStartSound(opts: { gameHandNo: number; previousPlayed: boolean; random?: () => number }): boolean {
  if (opts.gameHandNo <= 1) return true;
  if (opts.previousPlayed) return false;
  return (opts.random ?? Math.random)() < HAND_SOUND_CHANCE;
}
