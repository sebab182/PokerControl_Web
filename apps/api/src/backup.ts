/**
 * Convierte un backup de la APK (InfoModal) en filas válidas para el esquema.
 * Es tolerante con datos legacy: lo que no se puede importar se omite y queda
 * en `warnings`. Los ids se remapean a UUID para que un backup pueda importarse
 * en más de un grupo.
 */

import { randomUUID } from 'node:crypto';
import {
  CONSOLIDATED_SESSION_ID, MANUAL_DEBT_SESSION_ID, round2,
  type Debt, type DebtPayment, type Player, type Season, type Session,
} from '@pokercontrol/core';
import { ApiError } from './errors';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BackupData {
  poker_players: any[];
  poker_sessions: any[];
  poker_debts: any[];
  poker_seasons?: any[];
}

export interface ImportPlan {
  players: Player[];
  seasons: Season[];
  sessions: Session[];
  debts: Debt[];
  warnings: string[];
  archivedPlayers: number;
  adjustments: number;
}

const FALLBACK_NAME = 'Sin nombre';

function validDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function planImport(data: BackupData, now: string = new Date().toISOString()): ImportPlan {
  const warnings: string[] = [];
  const rawSeasons = data.poker_seasons ?? [];
  if (rawSeasons.filter(s => s?.status === 'active').length > 1) {
    throw new ApiError(422, 'import_multiple_active_seasons', 'El backup tiene más de una temporada activa.');
  }

  let rounded = 0;
  const amount = (value: unknown): number | null => {
    const n = Number(value);
    if (value === null || value === undefined || !Number.isFinite(n)) return null;
    const r = round2(n);
    if (r !== n) rounded++;
    return r;
  };

  // ─── Jugadores ────────────────────────────────────────────────────────────
  const playerIds = new Map<string, string>();
  const players: Player[] = [];
  let adjustments = 0;
  for (const p of data.poker_players) {
    if (!p?.id || playerIds.has(p.id)) continue;
    const id = randomUUID();
    playerIds.set(p.id, id);
    const list = Array.isArray(p.adjustments) ? p.adjustments : [];
    const parsed = list.flatMap((a: any) => {
      const value = amount(a?.amount);
      if (value === null) {
        warnings.push(`Ajuste inválido de ${p.name} omitido.`);
        return [];
      }
      return [{
        id: randomUUID(),
        description: String(a.description ?? '').trim(),
        amount: value,
        date: validDate(a.date) ?? now,
      }];
    });
    adjustments += parsed.length;
    players.push({
      id,
      name: String(p.name ?? '').trim() || FALLBACK_NAME,
      createdAt: validDate(p.createdAt) ?? now,
      archivedAt: validDate(p.archivedAt),
      adjustments: parsed,
    });
  }

  // Jugadores borrados en la app: siguen referenciados, se reconstruyen archivados.
  let archivedPlayers = 0;
  const ensurePlayer = (legacyId: unknown, name: unknown): string | null => {
    if (typeof legacyId !== 'string' || !legacyId) return null;
    const known = playerIds.get(legacyId);
    if (known) return known;
    const id = randomUUID();
    playerIds.set(legacyId, id);
    players.push({
      id,
      name: String(name ?? '').trim() || FALLBACK_NAME,
      createdAt: now,
      archivedAt: now,
      adjustments: [],
    });
    archivedPlayers++;
    return id;
  };

  // ─── Temporadas ───────────────────────────────────────────────────────────
  const seasonIds = new Map<string, string>();
  const seasons: Season[] = [];
  for (const s of rawSeasons) {
    if (!s?.id || seasonIds.has(s.id)) continue;
    const id = randomUUID();
    seasonIds.set(s.id, id);
    const createdAt = validDate(s.createdAt) ?? now;
    const status = s.status === 'active' ? 'active' : 'closed';
    seasons.push({
      id,
      name: String(s.name ?? '').trim() || FALLBACK_NAME,
      createdAt,
      status,
      closedAt: status === 'closed' ? validDate(s.closedAt) ?? createdAt : null,
    });
  }
  let orphanSeason: Season | null = null;
  const orphanSeasonId = (): string => {
    if (!orphanSeason) {
      // Mismo nombre que ensureInitialized. Activa solo si el backup no trae temporadas.
      orphanSeason = {
        id: randomUUID(),
        name: 'Temporada 1',
        createdAt: now,
        status: seasons.length === 0 ? 'active' : 'closed',
        closedAt: seasons.length === 0 ? null : now,
      };
      seasons.push(orphanSeason);
    }
    return orphanSeason.id;
  };

  // ─── Partidas ─────────────────────────────────────────────────────────────
  const sessionIds = new Map<string, string>();
  const sessions: Session[] = [];
  let orphanSessions = 0;
  for (const s of data.poker_sessions) {
    if (!s?.id || sessionIds.has(s.id)) continue;
    const id = randomUUID();
    sessionIds.set(s.id, id);
    const createdAt = validDate(s.createdAt) ?? now;
    const status = s.status === 'closed' ? 'closed' : 'active';

    let seasonId = seasonIds.get(s.seasonId);
    if (!seasonId) {
      seasonId = orphanSeasonId();
      orphanSessions++;
    }

    const participants = new Map<string, Session['participants'][number]>();
    for (const p of Array.isArray(s.participants) ? s.participants : []) {
      const playerId = ensurePlayer(p?.playerId, p?.name);
      if (!playerId) {
        warnings.push(`Participante sin jugador omitido en "${s.name}".`);
        continue;
      }
      const buys = (Array.isArray(p.buys) ? p.buys : []).flatMap((b: any) => {
        const value = amount(b?.amount);
        if (value === null || value <= 0) {
          warnings.push(`Compra inválida de ${p.name} omitida en "${s.name}".`);
          return [];
        }
        return [{ amount: value, timestamp: validDate(b.timestamp) ?? createdAt }];
      });
      const finalAmount = amount(p.finalAmount);
      const existing = participants.get(playerId);
      if (existing) {
        warnings.push(`Participante duplicado de ${p.name} fusionado en "${s.name}".`);
        existing.buys.push(...buys);
        existing.finalAmount = existing.finalAmount ?? finalAmount;
      } else {
        participants.set(playerId, { playerId, name: p.name ?? FALLBACK_NAME, buys, finalAmount });
      }
    }

    sessions.push({
      id,
      name: String(s.name ?? '').trim() || FALLBACK_NAME,
      createdAt,
      status,
      closedAt: status === 'closed' ? validDate(s.closedAt) ?? createdAt : null,
      seasonId,
      participants: [...participants.values()],
    });
  }
  if (orphanSessions > 0) warnings.push(`${orphanSessions} partida(s) sin temporada asignadas a "Temporada 1".`);
  if (seasons.length === 0) orphanSeasonId();

  // ─── Deudas ───────────────────────────────────────────────────────────────
  const debts: Debt[] = [];
  let manualConsolidated = 0;
  for (const d of data.poker_debts) {
    const label = String(d?.sessionName ?? '').trim() || FALLBACK_NAME;
    const fromId = ensurePlayer(d?.fromPlayer?.id, d?.fromPlayer?.name);
    const toId = ensurePlayer(d?.toPlayer?.id, d?.toPlayer?.name);
    const original = amount(d?.originalAmount);
    if (!fromId || !toId || fromId === toId || original === null || original <= 0) {
      warnings.push(`Deuda inválida "${label}" omitida.`);
      continue;
    }
    const pending = Math.min(original, Math.max(0, amount(d.pendingAmount) ?? 0));

    let sessionId: string;
    let isConsolidated = !!d.isConsolidated;
    if (d.sessionId === MANUAL_DEBT_SESSION_ID) {
      sessionId = MANUAL_DEBT_SESSION_ID;
    } else if (d.sessionId === CONSOLIDATED_SESSION_ID) {
      sessionId = CONSOLIDATED_SESSION_ID;
      isConsolidated = true;
    } else if (sessionIds.has(d.sessionId)) {
      sessionId = sessionIds.get(d.sessionId) as string;
    } else {
      sessionId = CONSOLIDATED_SESSION_ID;
      isConsolidated = true;
      warnings.push(`Deuda "${label}" de una partida inexistente: se importa como consolidada.`);
    }

    const isManual = sessionId === MANUAL_DEBT_SESSION_ID;
    if (isManual && isConsolidated && d.manualAmount === undefined) manualConsolidated++;

    const payments: DebtPayment[] = (Array.isArray(d.payments) ? d.payments : []).flatMap((p: any) => {
      const value = amount(p?.amount);
      if (value === null || value <= 0) return [];
      return [{ amount: value, date: validDate(p.date) ?? now, note: String(p.note ?? '') }];
    });

    debts.push({
      id: randomUUID(),
      fromPlayer: { id: fromId, name: String(d.fromPlayer.name ?? '') },
      toPlayer: { id: toId, name: String(d.toPlayer.name ?? '') },
      sessionId,
      sessionName: label,
      originalAmount: original,
      pendingAmount: pending,
      status: pending <= 0 ? 'paid' : pending < original || payments.length > 0 ? 'partial' : 'pending',
      payments,
      createdAt: validDate(d.createdAt) ?? now,
      isConsolidated,
      // Legacy no distingue la parte manual de una consolidada: entra entera como manual.
      manualAmount: amount(d.manualAmount) ?? (isManual ? pending : 0),
    });
  }
  if (manualConsolidated > 0) {
    warnings.push(`${manualConsolidated} deuda(s) consolidada(s) con ajuste previo se importan enteras como manuales.`);
  }
  if (archivedPlayers > 0) {
    warnings.push(`${archivedPlayers} jugador(es) borrados en la app se reconstruyen como archivados.`);
  }
  if (rounded > 0) warnings.push(`${rounded} monto(s) redondeados a 2 decimales.`);

  return { players, seasons, sessions, debts, warnings, archivedPlayers, adjustments };
}
