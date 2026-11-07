/**
 * Historial de manos para analizar cómo juega cada uno (ver docs/hand-history.md).
 *  - al repartir: una fila por jugador con su posición, fichas y cartas (recordHandStart);
 *  - en cada jugada: la situación en que se jugó, guardada en poker_actions (columnas street, kind, pot_before…);
 *  - al terminar: el resultado de cada jugador y los datos de la mano (recordHandResult).
 * Las manos anteriores a este detalle se reconstruyen con lo que sí tenían (backfillHandHistory), sin el detalle por calle.
 */

import {
  allInSpot, analyzeSession, cardScore, handClass, handPositions, summarizeHand, type ActionKind, type HandState, type InsightHand, type PlayerHandSummary, type RecordedAction, type StreetName,
} from '@pokercontrol/core';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
    handClass: handClass(p.hole),
    cardScore: cardScore(p.hole),
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
  await recordAllIn(tx, handId, state, actions);
}

/** Calle en que quedó todo el dinero adentro, o null si no hubo all-in con showdown. */
function allInStreet(state: HandState, actions: { playerId: string; street: string | null; kind: string | null; allIn: boolean }[]): StreetName | null {
  if (state.showdown.length < 2) return null;
  const flagged = [...actions].reverse().find(a => a.allIn && a.street);
  if (flagged) return flagged.street as StreetName;
  // Jugadas anteriores a la marca all_in: la última igualada o subida de quien terminó all-in.
  const allInIds = new Set(state.players.filter(p => p.allIn).map(p => p.id));
  const legacy = [...actions].reverse().find(a => a.street && allInIds.has(a.playerId) && (a.kind === 'call' || a.kind === 'raise'));
  if (legacy) return legacy.street as StreetName;
  // Todos quedaron all-in por las ciegas: no hubo jugadas.
  return actions.length === 0 && allInIds.size > 0 ? 'preflop' : null;
}

/** Guarda la probabilidad de ganar y el neto esperado de los jugadores del showdown si hubo all-in. */
async function recordAllIn(tx: Conn, handId: number, state: HandState, actions: Parameters<typeof allInStreet>[1]): Promise<void> {
  const street = allInStreet(state, actions);
  const spot = street ? allInSpot(state, street) : null;
  if (!spot) return;
  for (const [playerId, chance] of Object.entries(spot.equity)) {
    await tx.update(schema.pokerHandPlayers).set({ allInEquity: chance, evNet: spot.evNet[playerId] })
      .where(and(eq(schema.pokerHandPlayers.handId, handId), eq(schema.pokerHandPlayers.playerId, playerId)));
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
      pending: !!p.pending, hole: p.hole, handClass: handClass(p.hole), cardScore: cardScore(p.hole),
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

/**
 * Completa lo que agregó el análisis (clase y fuerza de las cartas, probabilidad de ganar en los all-in) en las manos
 * que ya estaban en el historial. Es idempotente: solo mira las manos con jugadores sin clase de mano. Devuelve cuántas completó.
 */
export async function backfillHandInsights(db: Db): Promise<number> {
  let done = 0;
  for (;;) {
    const batch = await db.select({ id: schema.pokerHands.id, state: schema.pokerHands.state })
      .from(schema.pokerHands)
      .where(and(
        eq(schema.pokerHands.status, 'done'),
        sql`exists (select 1 from poker_hand_players hp where hp.hand_id = ${schema.pokerHands.id} and hp.hand_class is null)`,
      ))
      .orderBy(asc(schema.pokerHands.id)).limit(200);
    if (batch.length === 0) return done;
    await db.transaction(async tx => {
      for (const h of batch) {
        const state = h.state as HandState;
        for (const p of state.players) {
          await tx.update(schema.pokerHandPlayers).set({ handClass: handClass(p.hole) ?? '--', cardScore: cardScore(p.hole) })
            .where(and(eq(schema.pokerHandPlayers.handId, h.id), eq(schema.pokerHandPlayers.playerId, p.id)));
        }
        const actions = await tx.select().from(schema.pokerActions).where(eq(schema.pokerActions.handId, h.id))
          .orderBy(asc(schema.pokerActions.seq));
        // Solo las manos con el detalle por calle: sin él no se sabe en qué calle quedó el dinero adentro.
        const [row] = await tx.select({ s: schema.pokerHandPlayers.hasStreetData }).from(schema.pokerHandPlayers)
          .where(eq(schema.pokerHandPlayers.handId, h.id)).limit(1);
        if (row?.s) await recordAllIn(tx, h.id, state, actions);
      }
    });
    done += batch.length;
  }
}

/** Las manos terminadas de una partida, como las lee el análisis. */
export async function loadInsightHands(db: Conn, sessionId: string): Promise<InsightHand[]> {
  const hands = await db.select().from(schema.pokerHands)
    .where(and(eq(schema.pokerHands.sessionId, sessionId), eq(schema.pokerHands.status, 'done')))
    .orderBy(asc(schema.pokerHands.handNo));
  if (hands.length === 0) return [];
  const ids = hands.map(h => h.id);
  const players = await db.select().from(schema.pokerHandPlayers).where(inArray(schema.pokerHandPlayers.handId, ids))
    .orderBy(asc(schema.pokerHandPlayers.seatOrder));
  const actions = await db.select().from(schema.pokerActions).where(inArray(schema.pokerActions.handId, ids))
    .orderBy(asc(schema.pokerActions.seq));
  return hands.map(h => ({
    id: h.id, handNo: h.handNo, smallBlind: h.smallBlind ?? 0, bigBlind: h.bigBlind ?? 0, pot: h.pot ?? 0,
    board: h.board ?? [], fullBoard: h.fullBoard, endedOn: (h.endedOn ?? 'preflop') as StreetName, wentToShowdown: !!h.wentToShowdown,
    players: players.filter(p => p.handId === h.id).map(p => ({
      playerId: p.playerId, position: p.position, startStack: p.startStack, pending: p.pending, hole: p.hole,
      invested: p.invested ?? 0, won: p.won ?? 0, net: p.net ?? 0, foldedStreet: p.foldedStreet as StreetName | null,
      sawFlop: !!p.sawFlop, vpip: !!p.vpip, pfr: !!p.pfr, allIn: !!p.allIn, showdown: !!p.showdown, wonShowdown: !!p.wonShowdown,
      cardScore: p.cardScore, handClass: p.handClass, allInEquity: p.allInEquity, evNet: p.evNet, hasStreetData: p.hasStreetData,
    })),
    actions: actions.filter(a => a.handId === h.id).map(a => ({
      seq: a.seq, playerId: a.playerId, street: a.street as StreetName | null, kind: a.kind as ActionKind | null, amount: a.amount,
      potBefore: a.potBefore, toCall: a.toCall, stackBefore: a.stackBefore, auto: a.auto, allIn: a.allIn, thinkMs: a.thinkMs,
    })),
  }));
}

/** Indicadores de una partida a partir de su historial de manos. */
export async function sessionInsights(db: Conn, sessionId: string) {
  return analyzeSession(await loadInsightHands(db, sessionId));
}

export type { Conn };
