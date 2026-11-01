/**
 * Reglas de temporadas. Solo una activa a la vez: crear o reabrir cierra la
 * activa. Las deudas y los ajustes quedan siempre globales.
 */

import type { DomainContext, Season } from './types';

export class SeasonRuleError extends Error {
  constructor(public code: 'season_not_found' | 'season_already_closed', message: string) {
    super(message);
  }
}

function require_(seasons: Season[], seasonId: string): Season {
  const target = seasons.find(s => s.id === seasonId);
  if (!target) throw new SeasonRuleError('season_not_found', 'Temporada no encontrada.');
  return target;
}

export function defaultSeasonName(existingCount: number): string {
  return `Temporada ${existingCount + 1}`;
}

export function createSeason(seasons: Season[], name: string, ctx: DomainContext): { seasons: Season[]; created: Season } {
  const now = ctx.now();
  const created: Season = {
    id: ctx.newId(),
    name: name.trim() || defaultSeasonName(seasons.length),
    createdAt: now,
    closedAt: null,
    status: 'active',
  };
  return {
    created,
    seasons: [
      ...seasons.map(s => (s.status === 'active' ? { ...s, status: 'closed' as const, closedAt: now } : s)),
      created,
    ],
  };
}

export function closeSeason(seasons: Season[], seasonId: string, now: string): Season[] {
  const target = require_(seasons, seasonId);
  if (target.status !== 'active') {
    throw new SeasonRuleError('season_already_closed', 'La temporada ya está cerrada.');
  }
  return seasons.map(s => (s.id === seasonId ? { ...s, status: 'closed' as const, closedAt: now } : s));
}

export function reopenSeason(seasons: Season[], seasonId: string, now: string): Season[] {
  const target = require_(seasons, seasonId);
  if (target.status === 'active') return seasons;
  return seasons.map(s => {
    if (s.id === seasonId) return { ...s, status: 'active' as const, closedAt: null };
    if (s.status === 'active') return { ...s, status: 'closed' as const, closedAt: now };
    return s;
  });
}
