import { round2 } from './money';

export interface BalanceRow {
  playerId: string;
  name: string;
  balance: number;
}

/** Del que más tiene para cobrar al que más debe; desempata por nombre. */
export function rankBalances<T extends BalanceRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name, 'es'));
}

/** Suma movimientos con signo por jugador, redondeando a centavos. */
export function sumBalances(entries: { playerId: string; amount: number }[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.playerId, round2((totals.get(e.playerId) ?? 0) + e.amount));
  return totals;
}

/**
 * Un pago solo reduce deuda: el pagador debe y el destinatario tiene a cobrar,
 * y no puede superar a ninguno de los dos. Devuelve el mensaje del error o null.
 */
export function validatePayment(
  fromBalance: number, toBalance: number, amount: number,
): string | null {
  if (fromBalance >= 0) return 'El pagador no tiene deuda.';
  if (toBalance <= 0) return 'El destinatario no tiene saldo a cobrar.';
  if (amount > -fromBalance) return 'El pago supera lo que debe el pagador.';
  if (amount > toBalance) return 'El pago supera lo que tiene a cobrar el destinatario.';
  return null;
}

/** Texto para compartir: saldos ordenados, sin los jugadores en cero. */
export function buildBalancesText(rows: BalanceRow[], fmt: (n: number) => string): string {
  const list = rankBalances(rows).filter(r => r.balance !== 0);
  if (list.length === 0) return '🤝 Todos los saldos están en cero.';
  const lines = list.map(r => `${r.balance > 0 ? '🟢' : '🔴'} ${r.name}: ${r.balance > 0 ? 'cobra' : 'debe'} ${fmt(Math.abs(r.balance))}`);
  return `💰 Saldos\n\n${lines.join('\n')}`;
}
