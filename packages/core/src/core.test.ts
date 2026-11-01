import { describe, expect, it } from 'vitest';
import {
  addManualDebt, applyMarkPaid, applyPayment, buildPlayerReport, buildWhatsAppSummary, calcDebts,
  calcParticipant, calcSession, canDeleteManualDebt, closeSeason, createSeason, debtsForPlayer,
  formatDate, generateDebtsFromSession, globalRanking, groupPendingByDebtor, hasDebtsToReorganize,
  MANUAL_DEBT_SESSION_ID, netDebts, parseAmount, pendingDebts, playerHistory, playerStats,
  reopenSeason, round2, SeasonRuleError,
} from './index';
import type { Debt, DebtTransaction, DomainContext, Participant, Season, Session } from './types';

let seq = 0;
const ctx: DomainContext = { newId: () => `id-${++seq}`, now: () => '2026-06-01T00:00:00.000Z' };
const ana = { id: '1', name: 'Ana' };
const beto = { id: '2', name: 'Beto' };
const caro = { id: '3', name: 'Caro' };

function participant(playerId: string, name: string, buys: number[], finalAmount: number | null): Participant {
  return {
    playerId, name, finalAmount,
    buys: buys.map(amount => ({ amount, timestamp: '2026-01-01T00:00:00.000Z' })),
  };
}

function closed(id: string, seasonId: string, date: string, participants: Participant[]): Session {
  return { id, name: `Partida ${id}`, createdAt: date, closedAt: date, status: 'closed', seasonId, participants };
}

const tx = (amount: number, from = beto, to = ana): DebtTransaction[] => [
  { from: from.name, fromId: from.id, to: to.name, toId: to.id, amount },
];
const s = (id: string) => ({ id, name: `Sesión ${id}` });

describe('calcParticipant / calcSession', () => {
  it('suma las compras y calcula el balance', () => {
    expect(calcParticipant(participant('1', 'Ana', [100, 50], 200)))
      .toEqual({ totalBought: 150, finalAmount: 200, balance: 50 });
  });
  it('trata finalAmount null como 0', () => {
    expect(calcParticipant(participant('1', 'Ana', [100], null)))
      .toEqual({ totalBought: 100, finalAmount: 0, balance: -100 });
  });
  it('detecta pozo exacto', () => {
    expect(calcSession({ participants: [participant('1', 'A', [100], 150), participant('2', 'B', [100], 50)] }))
      .toEqual({ totalPot: 200, totalOut: 200, diff: 0, status: 'ok' });
  });
  it('detecta sobrantes', () => {
    const r = calcSession({ participants: [participant('1', 'A', [100], 150), participant('2', 'B', [100], 100)] });
    expect(r.diff).toBe(50);
    expect(r.status).toBe('sobran');
  });
  it('detecta faltantes', () => {
    const r = calcSession({ participants: [participant('1', 'A', [100], 50), participant('2', 'B', [100], 100)] });
    expect(r.diff).toBe(-50);
    expect(r.status).toBe('faltan');
  });
});

describe('calcDebts', () => {
  it('genera una transacción entre dos jugadores', () => {
    expect(calcDebts({ participants: [participant('1', 'Ana', [100], 150), participant('2', 'Beto', [100], 50)] }))
      .toEqual([{ from: 'Beto', fromId: '2', to: 'Ana', toId: '1', amount: 50 }]);
  });
  it('minimiza transacciones', () => {
    const debts = calcDebts({
      participants: [participant('1', 'Ana', [100], 250), participant('2', 'Beto', [100], 50), participant('3', 'Caro', [100], 0)],
    });
    expect(debts).toHaveLength(2);
    expect(debts.reduce((sum, d) => sum + d.amount, 0)).toBe(150);
    expect(debts.every(d => d.to === 'Ana')).toBe(true);
  });
  it('ignora a los jugadores sin resultado', () => {
    expect(calcDebts({ participants: [participant('1', 'Ana', [100], 150), participant('2', 'Beto', [100], null)] })).toEqual([]);
  });
  it('no genera deudas si todos quedan saldados', () => {
    expect(calcDebts({ participants: [participant('1', 'Ana', [100], 100), participant('2', 'Beto', [100], 100)] })).toEqual([]);
  });
  it('devuelve vacío sin participantes', () => {
    expect(calcDebts({ participants: [] })).toEqual([]);
  });
});

describe('montos', () => {
  it('acepta coma, punto y miles', () => {
    expect(parseAmount('20,5')).toBe(20.5);
    expect(parseAmount('20.5')).toBe(20.5);
    expect(parseAmount('1.500,50')).toBe(1500.5);
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
  it('round2 elimina residuos de punto flotante', () => {
    expect(round2(300.3 - 100.1 - 200.2)).toBe(0);
  });
});

describe('generateDebtsFromSession', () => {
  it('crea una deuda pendiente', () => {
    const debts = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ sessionId: 's1', fromPlayer: beto, toPlayer: ana, pendingAmount: 50, status: 'pending' });
  });
  it('netea con deudas pendientes del mismo par', () => {
    const first = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    const all = generateDebtsFromSession(first, s('s2'), tx(30), ctx);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ pendingAmount: 80, isConsolidated: true });
  });
  it('invierte el sentido cuando la deuda se da vuelta', () => {
    const first = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    const all = generateDebtsFromSession(first, s('s2'), tx(80, ana, beto), ctx);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ fromPlayer: ana, toPlayer: beto, pendingAmount: 30 });
  });
  it('paridad: un neto menor a 1 elimina el par', () => {
    const first = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    expect(generateDebtsFromSession(first, s('s2'), tx(50, ana, beto), ctx)).toEqual([]);
  });
  it('bug 3: una consolidada que hereda pagos queda partial', () => {
    const [d] = generateDebtsFromSession([], s('s1'), tx(100), ctx);
    const paid = applyPayment(d, 40, '', ctx.now());
    const [merged] = generateDebtsFromSession([paid], s('s2'), tx(30), ctx);
    expect(merged).toMatchObject({ status: 'partial', pendingAmount: 90, originalAmount: 130 });
    expect(merged.payments).toHaveLength(1);
  });
});

describe('pagos', () => {
  const debt = (): Debt => generateDebtsFromSession([], s('s1'), tx(100), ctx)[0];
  it('un pago parcial deja partial', () => {
    const u = applyPayment(debt(), 40, '', ctx.now());
    expect(u).toMatchObject({ status: 'partial', pendingAmount: 60 });
    expect(u.payments).toHaveLength(1);
  });
  it('cubrir todo deja paid', () => {
    expect(applyPayment(debt(), 100, '', ctx.now())).toMatchObject({ status: 'paid', pendingAmount: 0 });
  });
  it('recorta el sobrepago', () => {
    expect(applyPayment(debt(), 999, '', ctx.now())).toMatchObject({ status: 'paid', pendingAmount: 0 });
  });
  it('markPaid salda el resto', () => {
    const u = applyMarkPaid(applyPayment(debt(), 40, '', ctx.now()), ctx.now());
    expect(u).toMatchObject({ status: 'paid', pendingAmount: 0 });
    expect(u.payments[1]).toMatchObject({ amount: 60, note: 'Saldado' });
  });
  it('un residuo de punto flotante no deja la deuda partial', () => {
    let d: Debt = { ...debt(), originalAmount: 300.3, pendingAmount: 300.3 };
    d = applyPayment(d, 100.1, '', ctx.now());
    d = applyPayment(d, 200.2, '', ctx.now());
    expect(d).toMatchObject({ status: 'paid', pendingAmount: 0 });
  });
  it('recorta la nota', () => {
    expect(applyPayment(debt(), 1, '  efectivo ', ctx.now()).payments[0].note).toBe('efectivo');
  });
});

describe('consultas de deudas', () => {
  it('excluye las saldadas', () => {
    const [d] = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    expect(pendingDebts([applyMarkPaid(d, ctx.now())])).toHaveLength(0);
  });
  it('separa lo que debe de lo que le deben', () => {
    const debts = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    expect(debtsForPlayer(debts, ana.id).owed).toHaveLength(1);
    expect(debtsForPlayer(debts, ana.id).owes).toHaveLength(0);
    expect(debtsForPlayer(debts, beto.id).owes).toHaveLength(1);
  });
  it('agrupa por deudor con el mayor total primero', () => {
    const debts = generateDebtsFromSession([], s('s1'), [...tx(50), ...tx(90, caro, ana)], ctx);
    const groups = groupPendingByDebtor(debts);
    expect(groups.map(g => g.player.id)).toEqual([caro.id, beto.id]);
    expect(groups[0].totalPending).toBe(90);
  });
});

describe('hasDebtsToReorganize', () => {
  const raw = (id: string, amount: number): Debt => ({
    id, fromPlayer: beto, toPlayer: ana, sessionId: id, sessionName: id, originalAmount: amount, pendingAmount: amount,
    status: 'pending', payments: [], createdAt: ctx.now(), isConsolidated: false, manualAmount: 0,
  });
  it('da false en el flujo normal', () => {
    const first = generateDebtsFromSession([], s('s1'), tx(50), ctx);
    expect(hasDebtsToReorganize(generateDebtsFromSession(first, s('s2'), tx(30), ctx))).toBe(false);
  });
  it('da false sin deudas', () => {
    expect(hasDebtsToReorganize([])).toBe(false);
  });
  it('da true con 2 o más sin netear del mismo par', () => {
    const debts = [raw('d1', 50), raw('d2', 30)];
    expect(hasDebtsToReorganize(debts)).toBe(true);
    expect(netDebts(debts, ctx)).toHaveLength(1);
  });
});

describe('deudas manuales', () => {
  it('crea una deuda con sessionId de ajuste previo', () => {
    const [d] = addManualDebt([], { fromPlayer: beto, toPlayer: ana, amount: 40, description: 'Asado' }, ctx);
    expect(d).toMatchObject({ sessionId: MANUAL_DEBT_SESSION_ID, sessionName: 'Asado', pendingAmount: 40, status: 'pending', manualAmount: 40 });
    expect(canDeleteManualDebt(d)).toBe(true);
  });
  it('usa "Ajuste previo" sin descripción', () => {
    expect(addManualDebt([], { fromPlayer: beto, toPlayer: ana, amount: 10 }, ctx)[0].sessionName).toBe('Ajuste previo');
  });
  it('se netea y la consolidada conserva la marca, sin poder borrarse', () => {
    const first = generateDebtsFromSession([], s('s1'), tx(30), ctx);
    const [merged, ...rest] = addManualDebt(first, { fromPlayer: beto, toPlayer: ana, amount: 20 }, ctx);
    expect(rest).toHaveLength(0);
    expect(merged).toMatchObject({ pendingAmount: 50, isConsolidated: true, sessionId: MANUAL_DEBT_SESSION_ID, manualAmount: 20 });
    expect(canDeleteManualDebt(merged)).toBe(false);
  });
  it('no se borra una deuda de partida', () => {
    expect(canDeleteManualDebt(generateDebtsFromSession([], s('s1'), tx(30), ctx)[0])).toBe(false);
  });
});

describe('playerStats y ranking', () => {
  const sessions = [
    closed('a', 't1', '2026-01-01T22:00:00.000Z', [participant('1', 'Ana', [100], 200), participant('2', 'Beto', [100], 0)]),
    closed('b', 't2', '2026-02-01T22:00:00.000Z', [participant('1', 'Ana', [100], 50), participant('2', 'Beto', [100], 150)]),
  ];
  const players = [{ id: '1', name: 'Ana', createdAt: '' }, { id: '2', name: 'Beto', createdAt: '' }];

  it('acota el historial a la temporada', () => {
    expect(playerHistory(sessions, '1', 't1').map(h => h.sessionId)).toEqual(['a']);
    expect(playerHistory(sessions, '1').map(h => h.sessionId)).toEqual(['b', 'a']);
  });
  it('devuelve null sin actividad', () => {
    expect(playerStats(undefined, '9', sessions, [])).toBeNull();
  });
  it('calcula totales, mejor y peor partida', () => {
    expect(playerStats(players[0], '1', sessions, [])).toMatchObject({
      totalGames: 2, wins: 1, losses: 1, ties: 0, winRate: 50, sessionBalance: 50, totalBalance: 50,
      bestGame: { sessionId: 'a' }, worstGame: { sessionId: 'b' },
    });
  });
  it('los ajustes y deudas manuales son globales', () => {
    const debts = addManualDebt([], { fromPlayer: beto, toPlayer: ana, amount: 40 }, ctx);
    const adjusted = { ...players[0], adjustments: [{ id: 'x', description: '', amount: 10, date: ctx.now() }] };
    expect(playerStats(adjusted, '1', sessions, debts, 't1')).toMatchObject({
      sessionBalance: 100, adjustmentsTotal: 10, manualDebtsNet: 40, totalBalance: 150,
    });
    expect(playerStats(players[1], '2', sessions, debts)?.manualDebtsNet).toBe(-40);
  });
  it('manualDebtsNet usa lo pendiente', () => {
    const [d] = addManualDebt([], { fromPlayer: beto, toPlayer: ana, amount: 40 }, ctx);
    expect(playerStats(players[0], '1', sessions, [applyPayment(d, 15, '', ctx.now())])?.manualDebtsNet).toBe(25);
    expect(playerStats(players[0], '1', sessions, [applyMarkPaid(d, ctx.now())])?.manualDebtsNet).toBe(0);
  });
  it('bug 9: una consolidada no suma dos veces la parte de partida', () => {
    const one = [closed('c', 't1', '2026-01-01T22:00:00.000Z', [participant('1', 'Ana', [100], 200), participant('2', 'Beto', [100], 0)])];
    const first = generateDebtsFromSession([], s('c'), tx(100), ctx);
    const debts = addManualDebt(first, { fromPlayer: beto, toPlayer: ana, amount: 50 }, ctx);
    expect(playerStats(players[0], '1', one, debts)).toMatchObject({ sessionBalance: 100, manualDebtsNet: 50, totalBalance: 150 });
    expect(playerStats(players[1], '2', one, debts)).toMatchObject({ sessionBalance: -100, manualDebtsNet: -50, totalBalance: -150 });
  });
  it('bug 9: conserva el signo si la manual iba en sentido contrario', () => {
    const first = generateDebtsFromSession([], s('c'), tx(100), ctx); // Beto → Ana 100
    const debts = addManualDebt(first, { fromPlayer: ana, toPlayer: beto, amount: 30 }, ctx); // Ana → Beto 30
    expect(debts[0]).toMatchObject({ fromPlayer: beto, pendingAmount: 70, manualAmount: -30 });
    expect(playerStats(players[0], '1', [], debts)?.manualDebtsNet).toBe(-30);
    expect(playerStats(players[1], '2', [], debts)?.manualDebtsNet).toBe(30);
  });
  it('ranking por temporada usa sessionBalance e incluye solo a quienes jugaron', () => {
    const ranking = globalRanking([...players, { id: '3', name: 'Caro', createdAt: '' }], sessions, [], 't2');
    expect(ranking.map(r => r.playerId)).toEqual(['2', '1']);
  });
  it('ranking histórico incluye ajustes y marca archivados', () => {
    const ranking = globalRanking([
      { ...players[1], archivedAt: ctx.now() },
      { ...players[0], adjustments: [{ id: 'x', description: '', amount: 500, date: ctx.now() }] },
    ], sessions, []);
    expect(ranking[0]).toMatchObject({ playerId: '1', totalBalance: 550, archived: false });
    expect(ranking[1]).toMatchObject({ playerId: '2', archived: true });
  });
});

describe('buildPlayerReport', () => {
  const at = (day: number) => `2026-03-${String(day).padStart(2, '0')}T22:00:00.000Z`;
  const buys = (...minutes: number[]) => minutes.map(m => ({ amount: 100, timestamp: new Date(Date.parse(at(1)) + m * 60000).toISOString() }));
  const sessions: Session[] = [
    closed('1', 't', at(1), [{ playerId: '1', name: 'Ana', finalAmount: 0, buys: buys(0) }]),
    closed('2', 't', at(2), [{ playerId: '1', name: 'Ana', finalAmount: 0, buys: buys(0) }]),
    closed('3', 't', at(3), [{ playerId: '1', name: 'Ana', finalAmount: 700, buys: buys(0, 30) }]),
    closed('4', 't', at(4), [{ playerId: '1', name: 'Ana', finalAmount: 200, buys: buys(0) }]),
  ];
  it('devuelve null si no jugó', () => {
    expect(buildPlayerReport('9', sessions)).toBeNull();
  });
  it('calcula compras, retorno, rachas y remontadas', () => {
    expect(buildPlayerReport('1', sessions)).toMatchObject({
      games: 4, avgBuysPerGame: 1.3, rebuyRate: 25, roi: 80, lowestCumulative: -200,
      nightComebacks: 1, longestWinStreak: 2, longestLossStreak: 2,
      currentStreak: { type: 'win', count: 2 },
      recoveries: [{ lowestBalance: -200, gamesToRecover: 1 }],
    });
  });
});

describe('temporadas', () => {
  const base = (): Season[] => createSeason([], 'Temporada 1', ctx).seasons;
  it('crear cierra la activa', () => {
    const { seasons, created } = createSeason(base(), ' T2 ', ctx);
    expect(created.name).toBe('T2');
    expect(seasons.filter(x => x.status === 'active').map(x => x.id)).toEqual([created.id]);
    expect(seasons[0].closedAt).toBe(ctx.now());
  });
  it('sin nombre usa Temporada N+1', () => {
    expect(createSeason(base(), '  ', ctx).created.name).toBe('Temporada 2');
  });
  it('cerrar deja sin activa y falla si ya está cerrada', () => {
    const list = base();
    const after = closeSeason(list, list[0].id, ctx.now());
    expect(after.every(x => x.status === 'closed')).toBe(true);
    expect(() => closeSeason(after, list[0].id, ctx.now())).toThrow(SeasonRuleError);
    expect(() => closeSeason(list, 'nada', ctx.now())).toThrow('Temporada no encontrada.');
  });
  it('reabrir activa la elegida y cierra la otra', () => {
    const { seasons, created } = createSeason(base(), 'T2', ctx);
    const after = reopenSeason(seasons, seasons[0].id, ctx.now());
    expect(after[0]).toMatchObject({ status: 'active', closedAt: null });
    expect(after.find(x => x.id === created.id)?.status).toBe('closed');
  });
  it('reabrir la activa no cambia nada', () => {
    const list = base();
    expect(reopenSeason(list, list[0].id, ctx.now())).toBe(list);
  });
});

describe('compartir y zona horaria', () => {
  it('antepone + a los balances positivos', () => {
    const text = buildWhatsAppSummary({
      id: 'x', name: 'Viernes', createdAt: '2026-01-01T00:00:00.000Z', status: 'closed',
      participants: [participant('1', 'Ana', [100], 150), participant('2', 'Beto', [100], 50)],
    });
    expect(text).toContain('Ana: +50$');
    expect(text).toContain('Beto: -50$');
  });
  it('una noche de las 22:00 en Buenos Aires conserva su día local con servidor en UTC', () => {
    expect(formatDate('2026-03-07T01:00:00.000Z', 'America/Argentina/Buenos_Aires')).toBe('6/3/2026');
    expect(formatDate('2026-03-07T01:00:00.000Z', 'UTC')).toBe('7/3/2026');
  });
});
