/**
 * Historial de manos para analizar cómo juega cada uno (ver docs/hand-history.md).
 *  - al repartir: una fila por jugador con su posición, fichas y cartas (recordHandStart);
 *  - en cada jugada: la situación en que se jugó, guardada en poker_actions (columnas street, kind, pot_before…);
 *  - al terminar: el resultado de cada jugador y los datos de la mano (recordHandResult).
 * Las manos anteriores a este detalle se reconstruyen con lo que sí tenían (backfillHandHistory), sin el detalle por calle.
 */

import {
  handPositions, summarizeHand, type ActionKind, type HandState, type PlayerHandSummary, type RecordedAction, type StreetName,
} from '@pokercontrol/core';
import { and, asc, eq, sql } from 'drizzle-orm';
import * as schema from './db/schema';
import type { Conn, Db, Tx } from './repo';

/** Cartas y datos de cada jugador al empezar la mano. `groupId` es el de la mesa. */
export async function recordHandStart(tx: Tx, groupId: string, handId: number, state: HandState): Promise<void> {
  const positions = handPositions(state);
  await tx.insert(schema.pokerHandPlayers).values(state.players.map((p, i) => ({
    handId,
    playerId: p.id,
    groupId,
    seatOrder: i,
    position: positions[p.id]?.position ?? null,
    positionIndex: positions[p.id]?.index ?? null,
    // Las ciegas ya se descontaron del stack: lo que tenía al empezar es lo que quedó más lo que puso.
    startStack: p.stack + p.totalBet,
    pending: !!p.pending,
    hole: p.hole,
  })));
}

/** Fichas que un pendiente de recompra compró durante la mano para jugarla. */
export async function recordBoughtInHand(tx: Tx, handId: number, playerId: string, chips: number): Promise<void> {
  await tx.update(schema.pokerHandPlayers).set({ boughtInHand: chips })
    .where(and(eq(schema.pokerHandPlayers.handId, handId), eq(schema.pokerHandPlayers.playerId, playerId)));
}

const detail = (p: PlayerHandSummary) => ({
  invested: p.invested, won: p.won, net: p.net, foldedStreet: p.foldedStreet, sawFlop: p.sawFlop, vpip: p.vpip, pfr: p.pfr,
  raises: p.raises, calls: p.calls, checks: p.checks, folds: p.folds, autoActions: p.autoActions,
  allIn: p.allIn, showdown: p.showdown, wonShowdown: p.wonShowdown,
});

/** Completa la mano al terminar: datos generales y resultado de cada jugador. */
export async function recordHandResult(tx: Tx, groupId: string, handId: number, state: HandState): Promise<void> {
  const existing = await tx.select({ playerId: schema.pokerHandPlayers.playerId }).from(schema.pokerHandPlayers)
    .where(eq(schema.pokerHandPlayers.handId, handId));
  if (existing.length === 0) {
    // Mano que empezó antes de que existiera el historial: se arma con lo que hay.
    await rebuildHand(tx, groupId, handId, state);
    return;
  }
  const actions = await tx.select().from(schema.pokerActions).where(eq(schema.pokerActions.handId, handId))
    .orderBy(asc(schema.pokerActions.seq));
  const recorded: RecordedAction[] = actions.filter(a => a.street && a.kind).map(a => ({
    playerId: a.playerId, street: a.street as StreetName, kind: a.kind as ActionKind, amount: a.amount, auto: a.auto,
  }));
  const summary = summarizeHand(state, recorded);
  await tx.update(schema.pokerHands).set({
    smallBlind: state.smallBlind, bigBlind: state.bigBlind,
    pot: summary.pot, board: summary.board, endedOn: summary.endedOn, wentToShowdown: summary.wentToShowdown,
  }).where(eq(schema.pokerHands.id, handId));
  for (const p of summary.players) {
    await tx.update(schema.pokerHandPlayers).set(detail(p))
      .where(and(eq(schema.pokerHandPlayers.handId, handId), eq(schema.pokerHandPlayers.playerId, p.playerId)));
  }
}

/**
 * Arma las filas de una mano terminada solo con su estado final: resultado, cartas y posición, pero no el detalle por
 * calle (vpip, pfr, jugadas), que no se puede saber. Esas columnas quedan en null y has_street_data en false.
 */
async function rebuildHand(tx: Tx, groupId: string, handId: number, state: HandState): Promise<void> {
  const summary = summarizeHand(state, []);
  const positions = handPositions(state);
  await tx.update(schema.pokerHands).set({
    smallBlind: state.smallBlind, bigBlind: state.bigBlind,
    pot: summary.pot, board: summary.board, endedOn: summary.endedOn, wentToShowdown: summary.wentToShowdown,
  }).where(eq(schema.pokerHands.id, handId));
  await tx.insert(schema.pokerHandPlayers).values(state.players.map((p, i) => {
    const s = summary.players[i];
    return {
      handId, playerId: p.id, groupId, seatOrder: i,
      position: positions[p.id]?.position ?? null, positionIndex: positions[p.id]?.index ?? null,
      // Con el estado final: fichas al terminar menos lo cobrado más lo aportado.
      startStack: Math.max(0, p.stack - s.won + p.totalBet),
      pending: !!p.pending, hole: p.hole,
      invested: s.invested, won: s.won, net: s.net, allIn: s.allIn, showdown: s.showdown, wonShowdown: s.wonShowdown,
      hasStreetData: false,
    };
  })).onConflictDoNothing();
}

/**
 * Reconstruye el historial de las manos terminadas que no lo tienen (las anteriores a esta función). Es idempotente y
 * rápido: solo mira las manos sin filas. Devuelve cuántas completó.
 */
export async function backfillHandHistory(db: Db): Promise<number> {
  let done = 0;
  for (;;) {
    const batch = await db.select({ id: schema.pokerHands.id, state: schema.pokerHands.state, groupId: schema.pokerTables.groupId })
      .from(schema.pokerHands).innerJoin(schema.pokerTables, eq(schema.pokerTables.id, schema.pokerHands.tableId))
      .where(and(
        eq(schema.pokerHands.status, 'done'),
        sql`not exists (select 1 from poker_hand_players hp where hp.hand_id = ${schema.pokerHands.id})`,
      ))
      .orderBy(asc(schema.pokerHands.id)).limit(200);
    if (batch.length === 0) return done;
    await db.transaction(async tx => {
      for (const h of batch) await rebuildHand(tx, h.groupId, h.id, h.state as HandState);
    });
    done += batch.length;
  }
}

export type { Conn };
