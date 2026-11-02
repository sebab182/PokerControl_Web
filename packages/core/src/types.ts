/**
 * Modelos de dominio. Portados de PokerControl/src/storage/types.ts.
 * Cambios: Buy.id, Player.archivedAt y Debt.manualAmount.
 */

export interface PlayerAdjustment {
  id: string;
  description: string;
  amount: number;
  date: string;
}

export interface Player {
  id: string;
  name: string;
  createdAt: string;
  archivedAt?: string | null;
  adjustments?: PlayerAdjustment[];
}

export interface Buy {
  id?: string;
  amount: number;
  timestamp: string;
}

export interface Participant {
  playerId: string;
  name: string;
  buys: Buy[];
  finalAmount: number | null;
}

export type SessionStatus = 'active' | 'closed';

export interface Session {
  id: string;
  name: string;
  createdAt: string;
  closedAt?: string | null;
  status: SessionStatus;
  seasonId?: string;
  participants: Participant[];
}

export type SeasonStatus = 'active' | 'closed';

export interface Season {
  id: string;
  name: string;
  createdAt: string;
  closedAt: string | null;
  status: SeasonStatus;
}

export interface DebtPlayerRef {
  id: string;
  name: string;
}

export interface DebtPayment {
  amount: number;
  date: string;
  note: string;
}

export type DebtStatus = 'pending' | 'partial' | 'paid';

export interface Debt {
  id: string;
  fromPlayer: DebtPlayerRef;
  toPlayer: DebtPlayerRef;
  /** Id de partida, o uno de los centinelas MANUAL_DEBT_SESSION_ID / CONSOLIDATED_SESSION_ID. */
  sessionId: string;
  sessionName: string;
  originalAmount: number;
  pendingAmount: number;
  status: DebtStatus;
  payments: DebtPayment[];
  createdAt: string;
  isConsolidated: boolean;
  /**
   * Parte manual de la deuda, con signo respecto de from → to. Negativa si la
   * parte manual iba en sentido contrario antes de netear.
   */
  manualAmount: number;
}

export interface DebtorGroup {
  player: DebtPlayerRef;
  debts: Debt[];
  totalPending: number;
}

/** Transacción de saldo mínimo calculada por calcDebts, previa a persistirse como Debt. */
export interface DebtTransaction {
  from: string;
  fromId: string;
  to: string;
  toId: string;
  amount: number;
}

export interface ParticipantCalc {
  totalBought: number;
  finalAmount: number;
  balance: number;
}

export type SessionBalanceStatus = 'ok' | 'faltan' | 'sobran';

export interface SessionCalc {
  totalPot: number;
  totalOut: number;
  diff: number;
  status: SessionBalanceStatus;
}

export interface PlayerHistoryEntry {
  sessionId: string;
  sessionName: string;
  date: string;
  totalBought: number;
  finalAmount: number;
  balance: number;
}

export interface PlayerStats {
  totalGames: number;
  wins: number;
  losses: number;
  ties: number;
  winRate: number;
  totalBalance: number;
  sessionBalance: number;
  adjustmentsTotal: number;
  manualDebtsNet: number;
  adjustments: PlayerAdjustment[];
  bestGame: PlayerHistoryEntry | null;
  worstGame: PlayerHistoryEntry | null;
  history: PlayerHistoryEntry[];
}

export interface RankingEntry extends PlayerStats {
  playerId: string;
  name: string;
}

/** Dependencias no deterministas, inyectadas para que el dominio sea puro. */
export interface DomainContext {
  newId: () => string;
  now: () => string;
}
