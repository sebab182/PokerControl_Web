/**
 * Informe de un jugador para "Compras y rachas" de Stats. Portado de
 * buildPlayerReport (PokerControl/src/storage/reports.ts); el resto de reports.ts
 * queda para la etapa de informes.
 */

import { calcParticipant } from './calc';
import type { Session } from './types';

export interface SessionRef {
  sessionId: string;
  sessionName: string;
  date: string;
}

export interface PlayerGameEntry extends SessionRef {
  buyCount: number;
  totalBought: number;
  balance: number;
  minutesToRebuy: number | null;
}

export interface Streak {
  type: 'win' | 'loss' | 'none';
  count: number;
}

export interface Recovery {
  lowestBalance: number;
  lowestAt: SessionRef;
  recoveredAt: SessionRef;
  gamesToRecover: number;
}

export interface PlayerReport {
  playerId: string;
  games: number;
  avgBuysPerGame: number;
  rebuyRate: number;
  roi: number;
  lowestCumulative: number;
  recoveries: Recovery[];
  nightComebacks: number;
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: Streak;
}

function sessionDate(s: Session): string {
  return s.closedAt || s.createdAt;
}

function minutesBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function buildPlayerReport(playerId: string, sessions: Session[], seasonId?: string): PlayerReport | null {
  const closed = sessions
    .filter(s => s.status === 'closed' && (!seasonId || s.seasonId === seasonId))
    .sort((a, b) => new Date(sessionDate(a)).getTime() - new Date(sessionDate(b)).getTime());

  const history: PlayerGameEntry[] = [];
  closed.forEach(s => {
    const p = s.participants.find(x => x.playerId === playerId && x.finalAmount !== null);
    if (!p) return;
    const { totalBought, balance } = calcParticipant(p);
    const buys = [...p.buys].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    history.push({
      sessionId: s.id,
      sessionName: s.name,
      date: sessionDate(s),
      buyCount: buys.length,
      totalBought,
      balance,
      minutesToRebuy: buys.length >= 2 ? minutesBetween(buys[0].timestamp, buys[1].timestamp) : null,
    });
  });

  const games = history.length;
  if (games === 0) return null;

  const buyCount = history.reduce((s, h) => s + h.buyCount, 0);
  const totalBought = history.reduce((s, h) => s + h.totalBought, 0);
  const balance = history.reduce((s, h) => s + h.balance, 0);
  const rebuyGames = history.filter(h => h.buyCount > 1).length;

  let cumulative = 0;
  let lowest = 0;
  let wentNegative = false;
  let holeLow = 0;
  let holeLowIdx = -1;
  const recoveries: Recovery[] = [];
  const ref = (h: PlayerGameEntry): SessionRef => ({
    sessionId: h.sessionId, sessionName: h.sessionName, date: h.date,
  });

  history.forEach((h, idx) => {
    cumulative += h.balance;
    lowest = Math.min(lowest, cumulative);
    if (cumulative < 0) {
      if (!wentNegative || cumulative < holeLow) {
        holeLow = cumulative;
        holeLowIdx = idx;
      }
      wentNegative = true;
    } else if (cumulative > 0 && wentNegative) {
      recoveries.push({
        lowestBalance: holeLow,
        lowestAt: ref(history[holeLowIdx]),
        recoveredAt: ref(h),
        gamesToRecover: idx - holeLowIdx,
      });
      wentNegative = false;
      holeLow = 0;
      holeLowIdx = -1;
    }
  });

  // Un empate corta cualquier racha.
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let run: Streak = { type: 'none', count: 0 };
  history.forEach(h => {
    const type: Streak['type'] = h.balance > 0 ? 'win' : h.balance < 0 ? 'loss' : 'none';
    run = type !== 'none' && type === run.type
      ? { type, count: run.count + 1 }
      : { type, count: type === 'none' ? 0 : 1 };
    if (run.type === 'win') longestWinStreak = Math.max(longestWinStreak, run.count);
    if (run.type === 'loss') longestLossStreak = Math.max(longestLossStreak, run.count);
  });

  return {
    playerId,
    games,
    avgBuysPerGame: round1(buyCount / games),
    rebuyRate: Math.round((rebuyGames / games) * 100),
    roi: totalBought > 0 ? Math.round((balance / totalBought) * 100) : 0,
    lowestCumulative: lowest,
    recoveries,
    nightComebacks: history.filter(h => h.buyCount >= 2 && h.balance > 0).length,
    longestWinStreak,
    longestLossStreak,
    currentStreak: run,
  };
}
