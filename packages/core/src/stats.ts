import { calcParticipant } from './calc';
import { effectiveManualAmount } from './debts';
import type {
  Debt, Player, PlayerHistoryEntry, PlayerStats, RankingEntry, Session,
} from './types';

/** Historial de un jugador en partidas cerradas, de la más nueva a la más vieja. */
export function playerHistory(sessions: Session[], playerId: string, seasonId?: string): PlayerHistoryEntry[] {
  return sessions
    .filter(s => s.status === 'closed' && (!seasonId || s.seasonId === seasonId))
    .map((s): PlayerHistoryEntry | null => {
      const participant = s.participants.find(p => p.playerId === playerId);
      if (!participant || participant.finalAmount === null) return null;
      const { totalBought, finalAmount, balance } = calcParticipant(participant);
      return {
        sessionId: s.id,
        sessionName: s.name,
        date: s.closedAt || s.createdAt,
        totalBought,
        finalAmount,
        balance,
      };
    })
    .filter((h): h is PlayerHistoryEntry => h !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

/**
 * Las partidas se limitan a la temporada; ajustes y deudas manuales son
 * globales. Solo cuenta la parte manual de cada deuda: la parte de partida ya
 * está en sessionBalance.
 */
export function playerStats(
  player: Pick<Player, 'id' | 'adjustments'> | undefined,
  playerId: string,
  sessions: Session[],
  debts: Debt[],
  seasonId?: string,
): PlayerStats | null {
  const history = playerHistory(sessions, playerId, seasonId);
  const adjustments = (player?.adjustments || [])
    .slice()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount, 0);

  const manualDebtsNet = debts
    .filter(d => d.status !== 'paid')
    .reduce((sum, d) => {
      if (d.toPlayer.id === playerId) return sum + effectiveManualAmount(d);
      if (d.fromPlayer.id === playerId) return sum - effectiveManualAmount(d);
      return sum;
    }, 0);

  if (history.length === 0 && adjustments.length === 0 && manualDebtsNet === 0) return null;

  const wins = history.filter(h => h.balance > 0).length;
  const losses = history.filter(h => h.balance < 0).length;
  const ties = history.filter(h => h.balance === 0).length;
  const bestGame = history.length > 0
    ? history.reduce((best, h) => (h.balance > best.balance ? h : best), history[0])
    : null;
  const worstGame = history.length > 0
    ? history.reduce((worst, h) => (h.balance < worst.balance ? h : worst), history[0])
    : null;
  const sessionBalance = history.reduce((sum, h) => sum + h.balance, 0);

  return {
    totalGames: history.length,
    wins,
    losses,
    ties,
    winRate: history.length > 0 ? Math.round((wins / history.length) * 100) : 0,
    totalBalance: sessionBalance + adjustmentsTotal + manualDebtsNet,
    sessionBalance,
    adjustmentsTotal,
    manualDebtsNet,
    adjustments,
    bestGame,
    worstGame,
    history,
  };
}

/**
 * Sin temporada: histórico por totalBalance. Con temporada: por sessionBalance
 * y solo quienes jugaron en ella. Excluye a los jugadores archivados.
 */
export function globalRanking(
  players: Player[],
  sessions: Session[],
  debts: Debt[],
  seasonId?: string,
): RankingEntry[] {
  const ranked = players
    .filter(p => !p.archivedAt)
    .map((p): RankingEntry | null => {
      const stats = playerStats(p, p.id, sessions, debts, seasonId);
      if (!stats) return null;
      if (seasonId && stats.totalGames === 0) return null;
      return { playerId: p.id, name: p.name, ...stats };
    })
    .filter((r): r is RankingEntry => r !== null);
  return seasonId
    ? ranked.sort((a, b) => b.sessionBalance - a.sessionBalance || b.totalGames - a.totalGames)
    : ranked.sort((a, b) => b.totalBalance - a.totalBalance || b.totalGames - a.totalGames);
}
