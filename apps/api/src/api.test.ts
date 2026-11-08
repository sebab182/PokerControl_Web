import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from './app';
import { ApiError } from './errors';
import { connect, runMigrations } from './db/client';
import { generateOpenApi, openapiPath } from './openapi';
import { planImport } from './backup';
import { EmojiClientMessage, TABLE_EMOJIS } from '@pokercontrol/contracts';
import { Value } from '@sinclair/typebox/value';
import { backfillHandHistory, backfillHandInsights } from './hand-history';
import { sweepTurns } from './routes/table';

// En CI no hay .env: TEST_DATABASE_URL llega por el entorno.
const envFile = resolve(__dirname, '../../../.env');
for (const line of existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/) : []) {
  const [k, ...v] = line.split('=');
  if (k && !process.env[k]) process.env[k] = v.join('=');
}
const url = process.env.TEST_DATABASE_URL as string;

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let conn: ReturnType<typeof connect>;
let keySeq = 0;

const verifier = async (token: string) => {
  if (token === 'bad') throw new ApiError(401, 'invalid_google_token', 'x');
  const [sub, verified] = token.split(':');
  return { sub, email: `${sub}@x.com`, name: sub, emailVerified: verified !== 'unverified', picture: null };
};

beforeAll(async () => {
  await runMigrations(url);
  conn = connect(url);
  app = await buildApp({
    db: conn.db,
    jwtSecret: 'test-secret',
    rateLimitMax: 100000,
    verifier,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await conn.pool.end();
});

beforeEach(async () => {
  await conn.pool.query('TRUNCATE users, groups CASCADE');
});

class Client {
  token = '';
  groupId = '';
  async call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, key?: string) {
    const scoped = path === '/g' || path.startsWith('/g/') ? `/groups/${this.groupId}${path.slice(2)}` : path;
    const res = await app.inject({
      method,
      url: `/api/v1${scoped}`,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }
  async ok(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, key?: string) {
    const r = await this.call(method, path, body, key);
    if (r.status !== 200) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  /** Para rutas que exigen Idempotency-Key. */
  idem(path: string, body?: unknown) {
    return this.ok('POST', path, body ?? {}, `test-key-${++keySeq}`);
  }
}

async function login(sub: string): Promise<Client> {
  const c = new Client();
  c.token = (await c.ok('POST', '/auth/google', { idToken: sub })).token;
  return c;
}

async function promote(sub: string) {
  await conn.pool.query(`update users set role = 'admin' where google_sub = $1 and role = 'reader'`, [sub]);
}

async function withGroup(sub = 'ana') {
  const c = await login(sub);
  await promote(sub);
  const group = await c.ok('POST', '/groups', { name: 'Mesa', timezone: 'America/Argentina/Buenos_Aires' });
  c.groupId = group.id;
  return { c, group };
}

async function seed(c: Client) {
  const season = (await c.ok('GET', '/g/seasons'))[0];
  const ana = await c.ok('POST', '/g/players', { name: 'Ana' });
  const beto = await c.ok('POST', '/g/players', { name: 'Beto' });
  return { season, ana, beto };
}

/** Partida cerrada: `beto` le debe `amount` a `ana`. */
async function closedSession(c: Client, seasonId: string, ana: { id: string }, beto: { id: string }, amount = 50) {
  const s = await c.idem(`/g/seasons/${seasonId}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
  await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 100 + amount });
  await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 100 - amount });
  await c.idem(`/g/sessions/${s.id}/close`);
  return s.id as string;
}

describe('auth', () => {
  it('rechaza requests sin token o con token inválido', async () => {
    const c = new Client();
    expect((await c.call('GET', '/groups')).status).toBe(401);
    c.token = 'basura';
    expect((await c.call('GET', '/groups')).body.error).toBe('unauthorized');
  });
  it('rechaza token de Google inválido y email sin verificar', async () => {
    const c = new Client();
    expect((await c.call('POST', '/auth/google', { idToken: 'bad' })).status).toBe(401);
    expect((await c.call('POST', '/auth/google', { idToken: 'x:unverified' })).body.error).toBe('email_not_verified');
  });
  it('el login es un upsert por sub, y refresh emite un token que funciona', async () => {
    const a = await login('ana');
    const b = await login('ana');
    const meA = await a.ok('GET', '/me');
    const meB = await b.ok('GET', '/me');
    expect(meA.user.id).toBe(meB.user.id);
    const { token } = await a.ok('POST', '/auth/refresh');
    a.token = token;
    expect((await a.ok('GET', '/me')).user.id).toBe(meA.user.id);
  });
});

describe('grupos', () => {
  it('crear deja al usuario como miembro, con Temporada 1 activa', async () => {
    const { c, group } = await withGroup();
    expect(group.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(group.members).toHaveLength(1);
    const seasons = await c.ok('GET', '/g/seasons');
    expect(seasons.map((s: { name: string; status: string }) => [s.name, s.status])).toEqual([['Temporada 1', 'active']]);
  });
  it('rechaza una zona horaria inválida', async () => {
    const c = await login('ana');
    expect((await c.call('POST', '/groups', { name: 'x', timezone: 'Marte/Base' })).body.error).toBe('invalid_timezone');
  });
  it('unirse, código inválido, ya miembro y varios grupos', async () => {
    const { group } = await withGroup('ana');
    const b = await login('beto');
    expect((await b.call('POST', '/groups/join', { inviteCode: 'NOEXISTE' })).body.error).toBe('invalid_code');
    await b.ok('POST', '/groups/join', { inviteCode: group.inviteCode.toLowerCase() });
    expect((await b.call('POST', '/groups/join', { inviteCode: group.inviteCode })).body.error).toBe('already_member');
    const { group: other } = await withGroup('caro');
    await b.ok('POST', '/groups/join', { inviteCode: other.inviteCode });
    expect(await b.ok('GET', '/groups')).toHaveLength(2);
  });
  it('rotar invitación invalida el código anterior', async () => {
    const { c, group } = await withGroup();
    const rotated = await c.ok('POST', `/g/invite/rotate`);
    expect(rotated.inviteCode).not.toBe(group.inviteCode);
    const b = await login('beto');
    expect((await b.call('POST', '/groups/join', { inviteCode: group.inviteCode })).status).toBe(404);
  });
  it('abandonar: 409 si es el último miembro', async () => {
    const { c, group } = await withGroup();
    expect((await c.call('DELETE', '/g/members/me')).body.error).toBe('last_member');
    const b = await login('beto');
    await b.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    b.groupId = group.id;
    await b.ok('POST', '/g/me/player', { name: 'Beto' });
    await b.ok('DELETE', '/g/members/me');
    expect((await b.call('GET', '/g/seasons')).status).toBe(403);
    expect((await c.ok('GET', '/g/players'))[0].linked).toBe(false);
  });
  it('limita los intentos de unirse', async () => {
    const limited = await buildApp({ db: conn.db, jwtSecret: 'test-secret', rateLimitMax: 3, verifier });
    await limited.ready();
    const token = limited.jwt.sign({ sub: 'alguien' });
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await limited.inject({
        method: 'POST', url: '/api/v1/groups/join',
        headers: { authorization: `Bearer ${token}` }, payload: { inviteCode: 'NOEXISTE' },
      });
      statuses.push(res.statusCode);
    }
    await limited.close();
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
  });
});

describe('aislamiento entre grupos', () => {
  it('un no miembro recibe 403 en cada recurso', async () => {
    const { c } = await withGroup('ana');
    const other = await login('intruso');
    other.groupId = c.groupId;
    for (const path of ['/g', '/g/players', '/g/seasons', '/g/balances', '/g/payments', '/g/ranking', '/g/backup/export']) {
      expect((await other.call('GET', path)).status).toBe(403);
    }
    expect((await other.call('POST', '/g/players', { name: 'x' })).status).toBe(403);
  });
  it('los recursos de otro grupo dan 404 desde el grupo propio', async () => {
    const { c: a } = await withGroup('ana');
    const { season, ana, beto } = await seed(a);
    const sessionId = await closedSession(a, season.id, ana, beto);
    const payment = await a.idem('/g/payments', { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 10 });

    const { c: b } = await withGroup('beto');
    expect((await b.call('GET', `/g/sessions/${sessionId}`)).status).toBe(404);
    expect((await b.call('GET', `/g/players/${ana.id}/stats`)).status).toBe(404);
    expect((await b.call('PATCH', `/g/players/${ana.id}`, { name: 'hack' })).status).toBe(404);
    expect((await b.call('DELETE', `/g/seasons/${season.id}`)).status).toBe(404);
    expect((await b.call('DELETE', `/g/payments/${payment.id}`)).status).toBe(404);
    expect(await b.ok('GET', '/g/balances')).toEqual([]);
    expect((await b.call('POST', `/g/seasons/${season.id}/sessions`, { playerIds: [] }, 'clave-aislada-2')).status).toBe(404);

    const own = (await b.ok('GET', '/g/seasons'))[0];
    const r = await b.call('POST', `/g/seasons/${own.id}/sessions`, { playerIds: [ana.id], initialBuyIn: 10 }, 'clave-aislada-3');
    expect(r.status).toBe(404);
  });
});

describe('temporadas', () => {
  it('crear y reabrir mantienen una sola activa', async () => {
    const { c } = await withGroup();
    const first = (await c.ok('GET', '/g/seasons'))[0];
    const second = await c.ok('POST', '/g/seasons', { name: 'T2' });
    expect(second.status).toBe('active');
    await c.ok('POST', `/g/seasons/${first.id}/reopen`);
    const list = await c.ok('GET', '/g/seasons');
    expect(list.filter((s: { status: string }) => s.status === 'active').map((s: { id: string }) => s.id)).toEqual([first.id]);
  });
  it('cerrar deja sin activa; cerrar dos veces da 409', async () => {
    const { c } = await withGroup();
    const s = (await c.ok('GET', '/g/seasons'))[0];
    expect((await c.ok('POST', `/g/seasons/${s.id}/close`)).status).toBe('closed');
    expect((await c.call('POST', `/g/seasons/${s.id}/close`)).body.error).toBe('season_already_closed');
  });
  it('no borra una temporada con partidas, y sí una vacía', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto);
    expect((await c.call('DELETE', `/g/seasons/${season.id}`)).body.error).toBe('season_has_sessions');
    const empty = await c.ok('POST', '/g/seasons', { name: 'Vacía' });
    expect((await c.ok('DELETE', `/g/seasons/${empty.id}`)).deleted).toBe(true);
  });
  it('informa partidas, abiertas y líder', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto);
    await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [] });
    const [s] = await c.ok('GET', '/g/seasons');
    expect(s).toMatchObject({ sessionCount: 2, openSessionCount: 1, leader: { name: 'Ana', sessionBalance: 50 } });
  });
});

describe('partidas', () => {
  it('crea con compras iniciales y nombre por defecto', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100.5 });
    expect(s.name).toMatch(/^Party \d{6}$/);
    expect(s.calc.totalPot).toBe(201);
    expect(typeof s.participants[0].buys[0].amount).toBe('number');
    expect(s.missingResults).toHaveLength(2);
  });
  it('rechaza montos con más de 2 decimales y exige Idempotency-Key', async () => {
    const { c } = await withGroup();
    const { season, ana } = await seed(c);
    const path = `/g/seasons/${season.id}/sessions`;
    expect((await c.call('POST', path, { playerIds: [] })).body.error).toBe('idempotency_key_required');
    expect((await c.call('POST', path, { playerIds: [ana.id], initialBuyIn: 1.234 }, 'clave-decimales')).body.error).toBe('invalid_amount');
  });
  it('agrega y borra compras por id, y quita participantes', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    let s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id], initialBuyIn: 100 });
    s = await c.ok('POST', `/g/sessions/${s.id}/participants`, { playerId: beto.id });
    s = await c.idem(`/g/sessions/${s.id}/buys`, { playerId: beto.id, amount: 30 });
    const buyId = s.participants[1].buys[0].id;
    s = await c.ok('DELETE', `/g/sessions/${s.id}/buys/${buyId}`);
    expect(s.participants[1].buys).toHaveLength(0);
    s = await c.ok('DELETE', `/g/sessions/${s.id}/participants/${beto.id}`);
    expect(s.participants).toHaveLength(1);
  });
  it('bug 2: una partida cerrada rechaza toda mutación', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const id = await closedSession(c, season.id, ana, beto);
    const closed = await c.ok('GET', `/g/sessions/${id}`);
    const buyId = closed.participants[0].buys[0].id;
    const calls = [
      await c.call('POST', `/g/sessions/${id}/buys`, { playerId: ana.id, amount: 1 }, 'clave-cerrada-1'),
      await c.call('PATCH', `/g/sessions/${id}/participants/${ana.id}`, { finalAmount: 1 }),
      await c.call('DELETE', `/g/sessions/${id}/buys/${buyId}`),
      await c.call('DELETE', `/g/sessions/${id}/participants/${ana.id}`),
      await c.call('POST', `/g/sessions/${id}/participants`, { playerId: beto.id }),
    ];
    expect(calls.map(r => r.body.error)).toEqual(Array(5).fill('session_closed'));
  });
  it('bug 1: cerrar dos veces da 409 y los saldos se acumulan una sola vez', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const first = await closedSession(c, season.id, ana, beto);
    await closedSession(c, season.id, ana, beto);
    expect((await c.ok('GET', '/g/balances')).map((b: { name: string; balance: number }) => [b.name, b.balance]))
      .toEqual([['Ana', 100], ['Beto', -100]]);
    expect((await c.call('POST', `/g/sessions/${first}/close`, {}, 'clave-recierre')).body.error).toBe('session_closed');
    expect((await c.ok('GET', '/g/balances'))[0].balance).toBe(100);
  });
  it('anular una partida cerrada revierte sus saldos sin borrarla, y reactivarla los restaura', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const first = await closedSession(c, season.id, ana, beto); // Ana +50
    await closedSession(c, season.id, ana, beto, 30); // Ana +30
    const balances = async () => (await c.ok('GET', '/g/balances')).map((b: { name: string; balance: number }) => [b.name, b.balance]);
    const anaScore = async () => (await c.ok('GET', '/g/ranking')).find((r: { name: string }) => r.name === 'Ana').sessionBalance;
    expect(await balances()).toEqual([['Ana', 80], ['Beto', -80]]);
    expect(await anaScore()).toBe(80);

    const voided = await c.idem(`/g/sessions/${first}/void`);
    expect(voided.session.status).toBe('voided');
    // Los saldos se corrigen y la partida deja de contar en el ranking, pero sigue ahí con sus datos.
    expect(await balances()).toEqual([['Ana', 30], ['Beto', -30]]);
    expect(await anaScore()).toBe(30);
    const kept = await c.ok('GET', `/g/sessions/${first}`);
    expect([kept.status, kept.participants.length, kept.closedAt === null]).toEqual(['voided', 2, false]);
    expect((await c.ok('GET', `/g/seasons/${season.id}/sessions`)).map((x: { status: string }) => x.status).sort()).toEqual(['closed', 'voided']);
    expect((await c.ok('GET', '/g/seasons'))[0].sessionCount).toBe(1);
    // Anulada no se edita, ni se vuelve a anular.
    expect((await c.call('PATCH', `/g/sessions/${first}/participants/${ana.id}`, { finalAmount: 1 })).body.error).toBe('session_closed');
    expect((await c.call('POST', `/g/sessions/${first}/void`, {}, 'clave-anular-2')).body.error).toBe('not_closed');
    expect((await c.call('POST', `/g/sessions/${first}/close`, {}, 'clave-anular-3')).body.error).toBe('session_closed');

    const restored = await c.idem(`/g/sessions/${first}/restore`);
    expect(restored.session.status).toBe('closed');
    expect(await balances()).toEqual([['Ana', 80], ['Beto', -80]]);
    expect(await anaScore()).toBe(80);
    expect((await c.call('POST', `/g/sessions/${first}/restore`, {}, 'clave-restaurar-2')).body.error).toBe('not_voided');
    const { rows } = await conn.pool.query(`select count(*)::int as n from balance_entries where note = 'anulación'`);
    expect(rows[0].n).toBe(0);
  });
  it('una partida abierta no se puede anular', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    expect((await c.call('POST', `/g/sessions/${s.id}/void`, {}, 'clave-anular-abierta')).body.error).toBe('not_closed');
  });
  it('pide confirmar la diferencia, y rechaza si cambió', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 20 });
    const first = await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-diff-1');
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ error: 'pot_mismatch', diff: -30, status: 'faltan' });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 10 });
    expect((await c.call('POST', `/g/sessions/${s.id}/close`, { confirmedDiff: -30 }, 'clave-diff-2')).status).toBe(409);
    const closed = await c.ok('POST', `/g/sessions/${s.id}/close`, { confirmedDiff: -40 }, 'clave-diff-3');
    expect(closed.session.status).toBe('closed');
  });
  it('una diferencia dentro de la tolerancia no pide confirmación', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 51 });
    expect((await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-tolerancia')).status).toBe(200);
  });
  it('los participantes sin resultado requieren confirmación y su saldo no cambia', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 200 });
    const r = await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-faltan-1');
    expect(r.body.missingResults).toEqual([beto.id]);
    // Con el pozo exacto igual se confirma, porque falta un resultado.
    const closed = await c.ok('POST', `/g/sessions/${s.id}/close`, { confirmedDiff: 0 }, 'clave-faltan-2');
    expect(closed.session.status).toBe('closed');
    const balances = await c.ok('GET', '/g/balances');
    expect(balances.find((b: { name: string }) => b.name === 'Beto').balance).toBe(0);
  });
  it('bug 6: borrar una partida recalcula los saldos', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const a = await closedSession(c, season.id, ana, beto);
    await closedSession(c, season.id, ana, beto, 20);
    expect((await c.ok('GET', '/g/balances'))[0].balance).toBe(70);
    expect((await c.ok('DELETE', `/g/sessions/${a}`)).deleted).toBe(true);
    expect((await c.ok('GET', '/g/balances'))[0].balance).toBe(20);
  });
  it('la vista de la partida muestra resultado, saldo previo y saldo posterior', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const a = await closedSession(c, season.id, ana, beto);
    await closedSession(c, season.id, ana, beto, 20);
    const view = await c.ok('GET', `/g/sessions/${a}/debts`);
    expect(view.balances[0]).toMatchObject({ playerId: ana.id, result: 50, before: 0, after: 50 });
    expect(view.balances[1]).toMatchObject({ playerId: beto.id, result: -50, before: 0, after: -50 });
    const second = (await c.ok('GET', '/g/seasons'))[0];
    expect(second).toBeTruthy();
  });
});

describe('idempotencia y concurrencia', () => {
  it('repetir una compra con la misma clave no la duplica y devuelve lo mismo', async () => {
    const { c } = await withGroup();
    const { season, ana } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id], initialBuyIn: 100 });
    const body = { playerId: ana.id, amount: 30 };
    const a = await c.ok('POST', `/g/sessions/${s.id}/buys`, body, 'misma-clave');
    const b = await c.ok('POST', `/g/sessions/${s.id}/buys`, body, 'misma-clave');
    expect(b).toEqual(a);
    expect((await c.ok('GET', `/g/sessions/${s.id}`)).calc.totalPot).toBe(130);
  });
  it('una request fallida libera la clave', async () => {
    const { c } = await withGroup();
    const { season, ana } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id], initialBuyIn: 100 });
    expect((await c.call('POST', `/g/sessions/${s.id}/buys`, { playerId: 'x', amount: 1 }, 'clave-falla')).status).toBe(404);
    expect((await c.call('POST', `/g/sessions/${s.id}/buys`, { playerId: ana.id, amount: 1 }, 'clave-falla')).status).toBe(200);
  });
  it('compras paralelas con la misma clave aplican una sola vez', async () => {
    const { c } = await withGroup();
    const { season, ana } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id], initialBuyIn: 100 });
    const rs = await Promise.all(Array.from({ length: 5 }, () =>
      c.call('POST', `/g/sessions/${s.id}/buys`, { playerId: ana.id, amount: 10 }, 'clave-paralela')));
    expect(rs.every(r => r.status === 200)).toBe(true);
    expect((await c.ok('GET', `/g/sessions/${s.id}`)).calc.totalPot).toBe(110);
  });
  it('compras paralelas distintas no pierden datos', async () => {
    const { c } = await withGroup();
    const { season, ana } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id], initialBuyIn: 100 });
    await Promise.all(Array.from({ length: 8 }, () => c.idem(`/g/sessions/${s.id}/buys`, { playerId: ana.id, amount: 10 })));
    expect((await c.ok('GET', `/g/sessions/${s.id}`)).calc.totalPot).toBe(180);
  });
  it('cierres paralelos suman el resultado una sola vez', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 50 });
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => c.call('POST', `/g/sessions/${s.id}/close`, {}, `cierre-paralelo-${i}`)));
    expect(rs.filter(r => r.status === 200)).toHaveLength(1);
    expect(rs.filter(r => r.status === 409)).toHaveLength(4);
    const balances = await c.ok('GET', '/g/balances');
    expect(balances.map((b: { balance: number }) => b.balance)).toEqual([50, -50]);
  });
  it('pagos paralelos no superan lo que se debe', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      c.call('POST', '/g/payments', { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 20 }, `pago-paralelo-${i}`)));
    expect(rs.filter(r => r.status === 200)).toHaveLength(2);
    expect((await c.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance)).toEqual([10, -10]);
    expect(await c.ok('GET', '/g/payments')).toHaveLength(2);
  });
  it('compra contra cierre: el resultado final siempre es coherente', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 50 });
    const [buy, close] = await Promise.all([
      c.call('POST', `/g/sessions/${s.id}/buys`, { playerId: ana.id, amount: 40 }, 'carrera-compra'),
      c.call('POST', `/g/sessions/${s.id}/close`, {}, 'carrera-cierre'),
    ]);
    const final = await c.ok('GET', `/g/sessions/${s.id}`);
    if (close.status === 200) {
      expect(buy.body.error).toBe('session_closed');
      expect(final.calc.totalPot).toBe(200);
    } else {
      expect(close.body.error).toBe('pot_mismatch');
      expect(final.status).toBe('active');
      expect(final.calc.totalPot).toBe(240);
    }
  });
  it('rollback: si falla el registro de saldos, la partida sigue abierta', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 50 });
    await conn.pool.query('ALTER TABLE balance_entries ADD CONSTRAINT ck_test_falla CHECK (amount > 1000) NOT VALID');
    try {
      expect((await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-rollback')).status).toBe(500);
      expect((await c.ok('GET', `/g/sessions/${s.id}`)).status).toBe('active');
    } finally {
      await conn.pool.query('ALTER TABLE balance_entries DROP CONSTRAINT ck_test_falla');
    }
    expect((await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-rollback')).status).toBe(200);
  });
});

describe('deudas', () => {
  it('deudas manuales: validación, DTO limpio y borrado', async () => {
    const { c } = await withGroup();
    const { ana, beto } = await seed(c);
    expect((await c.call('POST', '/g/debts/manual', { fromPlayerId: ana.id, toPlayerId: ana.id, amount: 1 })).body.error).toBe('same_player');
    const [debt] = await c.ok('POST', '/g/debts/manual', { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 40, description: 'Asado' });
    expect(debt).toMatchObject({ sourceType: 'manual', sessionId: null, label: 'Asado', manualAmount: 40, isConsolidated: false });
    expect((await c.ok('GET', `/g/players/${ana.id}/stats`)).manualDebtsNet).toBe(40);
    await c.ok('DELETE', `/g/debts/manual/${debt.id}`);
    expect(await c.ok('GET', '/g/debts')).toEqual([]);
  });
});

describe('reorganizar y deshacer', () => {
  async function unnetted(c: Client, ana: { id: string }, beto: { id: string }) {
    const { rows: [{ id: gid }] } = await conn.pool.query('select id from groups limit 1');
    for (const [id, amount] of [['d1', 50], ['d2', 30]] as const) {
      await conn.pool.query(
        `insert into debts (id, group_id, from_player_id, to_player_id, source_type, label, original_amount, pending_amount, status, is_consolidated)
         values ($1, $2, $3, $4, 'consolidated', 'x', $5, $5, 'pending', true)`, [id, gid, beto.id, ana.id, amount]);
    }
  }
  it('sin backup no se puede deshacer', async () => {
    const { c } = await withGroup();
    expect(await c.ok('GET', '/g/debts/reorganize-status')).toEqual({ canReorganize: false, canUndo: false, reason: 'no_backup' });
    expect((await c.call('POST', '/g/debts/renet/undo')).body).toMatchObject({ error: 'cannot_undo', reason: 'no_backup' });
  });
  it('reorganiza y deshace restaurando el estado anterior', async () => {
    const { c } = await withGroup();
    const { ana, beto } = await seed(c);
    await unnetted(c, ana, beto);
    expect((await c.ok('GET', '/g/debts/reorganize-status')).canReorganize).toBe(true);
    const netted = await c.ok('POST', '/g/debts/renet');
    expect(netted).toHaveLength(1);
    expect(netted[0].pendingAmount).toBe(80);
    expect(await c.ok('GET', '/g/debts/reorganize-status')).toMatchObject({ canUndo: true, reason: null });
    const restored = await c.ok('POST', '/g/debts/renet/undo');
    expect(restored.map((d: { id: string }) => d.id).sort()).toEqual(['d1', 'd2']);
    expect((await c.ok('GET', '/g/debts/reorganize-status')).reason).toBe('no_backup');
  });
  it('bug 4: un pago bloquea deshacer, incluso si el neteo eliminó pagos previos', async () => {
    const { c } = await withGroup();
    const { ana, beto } = await seed(c);
    await unnetted(c, ana, beto);
    const [netted] = await c.ok('POST', '/g/debts/renet');
    await c.idem(`/g/debts/${netted.id}/payments`, { amount: 10 });
    expect(await c.ok('GET', '/g/debts/reorganize-status')).toMatchObject({ canUndo: false, reason: 'has_payments' });
    expect((await c.call('POST', '/g/debts/renet/undo')).status).toBe(409);
  });
  it('bug 4: heredar pagos al reorganizar no bloquea el deshacer', async () => {
    const { c } = await withGroup();
    const { ana, beto } = await seed(c);
    await unnetted(c, ana, beto);
    await c.idem('/g/debts/d1/payments', { amount: 5 });
    await c.ok('POST', '/g/debts/renet');
    expect((await c.ok('GET', '/g/debts/reorganize-status')).canUndo).toBe(true);
  });
  it('bug 5: agregar una manual invalida el backup', async () => {
    const { c } = await withGroup();
    const { ana, beto } = await seed(c);
    await unnetted(c, ana, beto);
    await c.ok('POST', '/g/debts/renet');
    const caro = await c.ok('POST', '/g/players', { name: 'Caro' });
    await c.ok('POST', '/g/debts/manual', { fromPlayerId: caro.id, toPlayerId: ana.id, amount: 5 });
    expect((await c.ok('GET', '/g/debts/reorganize-status')).reason).toBe('no_backup');
  });
  it('un jugador presente solo en el snapshot se archiva y el undo no falla', async () => {
    const { c } = await withGroup();
    const { ana, beto } = await seed(c);
    const { rows: [{ id: gid }] } = await conn.pool.query('select id from groups limit 1');
    // Se cancelan entre sí: el neteo elimina las únicas deudas del par.
    for (const [id, from, to] of [['x1', beto.id, ana.id], ['x2', ana.id, beto.id]]) {
      await conn.pool.query(
        `insert into debts (id, group_id, from_player_id, to_player_id, source_type, label, original_amount, pending_amount, status, is_consolidated)
         values ($1, $2, $3, $4, 'consolidated', 'x', 10, 10, 'pending', true)`, [id, gid, from, to]);
    }
    expect(await c.ok('POST', '/g/debts/renet')).toEqual([]);
    expect((await c.ok('DELETE', `/g/players/${beto.id}`)).archived).toBe(true);
    expect(await c.ok('POST', '/g/debts/renet/undo')).toHaveLength(2);
  });
});

describe('jugadores', () => {
  it('sin historial se borra; con historial se archiva y sale del ranking y del líder', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const caro = await c.ok('POST', '/g/players', { name: 'Caro' });
    expect((await c.ok('DELETE', `/g/players/${caro.id}`)).archived).toBe(false);
    const sessionId = await closedSession(c, season.id, ana, beto);
    // Ana va primera: al archivarla, el líder pasa a ser Beto.
    expect((await c.ok('DELETE', `/g/players/${ana.id}`)).archived).toBe(true);
    expect((await c.ok('GET', '/g/players')).map((p: { id: string }) => p.id)).toEqual([beto.id]);
    expect(await c.ok('GET', '/g/players?includeArchived=true')).toHaveLength(2);
    const ranking = await c.ok('GET', '/g/ranking');
    expect(ranking.map((r: { playerId: string }) => r.playerId)).toEqual([beto.id]);
    expect((await c.ok('GET', '/g/seasons'))[0].leader.playerId).toBe(beto.id);
    // Sigue visible en la partida, en sus estadísticas y en los saldos.
    const session = await c.ok('GET', `/g/sessions/${sessionId}`);
    expect(session.participants.map((p: { playerId: string }) => p.playerId)).toContain(ana.id);
    expect((await c.ok('GET', `/g/players/${ana.id}/stats`)).sessionBalance).toBe(50);
    expect((await c.ok('GET', '/g/balances')).find((b: { playerId: string }) => b.playerId === ana.id).balance).toBe(50);
  });
  it('un archivado no entra en partidas ni deudas, hasta desarchivarlo', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await c.ok('POST', `/g/players/${beto.id}/adjustments`, { description: 'x', amount: 5 });
    await c.ok('DELETE', `/g/players/${beto.id}`);
    const sessionBody = { playerIds: [beto.id], initialBuyIn: 10 };
    expect((await c.call('POST', `/g/seasons/${season.id}/sessions`, sessionBody, 'clave-archivado')).body.error).toBe('player_archived');
    const manual = { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 1 };
    expect((await c.call('POST', '/g/debts/manual', manual)).body.error).toBe('player_archived');
    await c.ok('POST', `/g/players/${beto.id}/unarchive`);
    await c.ok('POST', '/g/debts/manual', manual);
  });
  it('renombrar actualiza también el historial', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const id = await closedSession(c, season.id, ana, beto);
    await c.ok('PATCH', `/g/players/${ana.id}`, { name: 'Anita' });
    expect((await c.ok('GET', `/g/sessions/${id}`)).participants[0].name).toBe('Anita');
    expect((await c.ok('GET', '/g/balances'))[0].name).toBe('Anita');
    expect((await c.call('PATCH', `/g/players/${ana.id}`, { name: '   ' })).body.error).toBe('invalid_name');
  });
  it('ajustes: alta, edición y borrado', async () => {
    const { c } = await withGroup();
    const { ana } = await seed(c);
    const { adjustments: [a] } = await c.ok('POST', `/g/players/${ana.id}/adjustments`, { description: ' x ', amount: -5.5 });
    expect(a).toMatchObject({ description: 'x', amount: -5.5 });
    const updated = await c.ok('PATCH', `/g/players/${ana.id}/adjustments/${a.id}`, { description: 'y', amount: 7 });
    expect(updated.adjustments[0]).toMatchObject({ description: 'y', amount: 7 });
    expect((await c.ok('GET', `/g/players/${ana.id}/stats`)).totalBalance).toBe(7);
    await c.ok('DELETE', `/g/players/${ana.id}/adjustments/${a.id}`);
    expect((await c.call('DELETE', `/g/players/${ana.id}/adjustments/${a.id}`)).status).toBe(404);
    expect(await c.ok('GET', `/g/players/${ana.id}/stats`)).toBeNull();
  });
  it('stats, informe, deudas y ranking por temporada', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const other = await c.ok('POST', '/g/seasons', { name: 'T2' });
    expect(await c.ok('GET', `/g/players/${ana.id}/stats?seasonId=${other.id}`)).toBeNull();
    expect((await c.ok('GET', `/g/players/${ana.id}/stats?seasonId=${season.id}`)).sessionBalance).toBe(50);
    expect((await c.ok('GET', `/g/players/${ana.id}/report`)).games).toBe(1);
    expect(await c.ok('GET', `/g/players/${ana.id}/report?seasonId=${other.id}`)).toBeNull();
    expect((await c.ok('GET', `/g/ranking?seasonId=${season.id}`))[0].playerId).toBe(ana.id);
    expect(await c.ok('GET', `/g/ranking?seasonId=${other.id}`)).toEqual([]);
  });
});

describe('saldos y pagos', () => {
  it('el saldo inicial se corrige al crear y al cerrar, y arranca del último saldo conocido', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    // Beto pagó 30 por fuera: su saldo real al empezar es -20.
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, {
      playerIds: [ana.id, beto.id], initialBuyIn: 100, balances: [{ playerId: beto.id, amount: -20 }],
    });
    expect((await c.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance)).toEqual([50, -20]);
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 110 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 90 });
    // Al cerrar, Ana cobró 10 por fuera: su saldo real queda en 40 en lugar de 60.
    await c.ok('POST', `/g/sessions/${s.id}/close`, { balances: [{ playerId: ana.id, amount: 40 }] }, 'cierre-con-saldos');
    expect((await c.ok('GET', '/g/balances')).map((b: { name: string; balance: number }) => [b.name, b.balance]))
      .toEqual([['Ana', 40], ['Beto', -30]]);
    const view = await c.ok('GET', `/g/sessions/${s.id}/debts`);
    expect(view.balances.find((b: { playerId: string }) => b.playerId === ana.id)).toMatchObject({ before: 50, result: 10, after: 40 });
  });
  it('actualizar saldos: solo admin, guarda la diferencia y rechaza archivados', async () => {
    const { c, group } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const updated = await c.ok('PUT', '/g/balances', { balances: [{ playerId: beto.id, amount: -20 }], note: 'pagó por fuera' });
    expect(updated.map((b: { name: string; balance: number }) => [b.name, b.balance])).toEqual([['Ana', 50], ['Beto', -20]]);
    expect((await c.ok('PUT', '/g/balances', { balances: [{ playerId: beto.id, amount: -20 }] })).length).toBe(2);
    expect((await c.call('PUT', '/g/balances', { balances: [{ playerId: 'nada', amount: 1 }] })).status).toBe(404);
    await c.ok('DELETE', `/g/players/${beto.id}`);
    expect((await c.call('PUT', '/g/balances', { balances: [{ playerId: beto.id, amount: 0 }] })).body.error).toBe('player_archived');

    const reader = await login('lector');
    await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    reader.groupId = c.groupId;
    expect((await reader.call('PUT', '/g/balances', { balances: [{ playerId: ana.id, amount: 1 }] })).status).toBe(403);
  });
  it('un usuario común registra pagos solo a su nombre, y puede deshacerlos', async () => {
    const { c, group } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const reader = await login('lector');
    await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    reader.groupId = c.groupId;
    await reader.ok('POST', '/g/me/player', { playerId: beto.id });

    const body = (from: string, to: string) => ({ fromPlayerId: from, toPlayerId: to, amount: 20 });
    // Ana cobra: un usuario común no puede registrar pagos de otro.
    expect((await reader.call('POST', '/g/payments', body(ana.id, beto.id), 'pago-ajeno')).body.error).toBe('not_your_payment');
    const mine = await reader.ok('POST', '/g/payments', body(beto.id, ana.id), 'pago-propio');
    expect((await c.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance)).toEqual([30, -30]);
    // Tampoco puede tocar saldos ni pagos ajenos.
    expect((await reader.call('PUT', '/g/balances', { balances: [{ playerId: beto.id, amount: 0 }] })).status).toBe(403);
    const other = await c.idem('/g/payments', body(beto.id, ana.id));
    await c.ok('DELETE', `/g/payments/${other.id}`);
    const stranger = await login('otro');
    await stranger.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    stranger.groupId = c.groupId;
    await stranger.ok('POST', '/g/me/player', { name: 'Caro' });
    const again = await c.idem('/g/payments', body(beto.id, ana.id));
    expect((await stranger.call('DELETE', `/g/payments/${again.id}`)).body.error).toBe('not_your_payment');
    await reader.ok('DELETE', `/g/payments/${mine.id}`);
    await c.ok('DELETE', `/g/payments/${again.id}`);
    expect((await c.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance)).toEqual([50, 0, -50]);
  });
  it('rechaza saldos de jugadores que no están en la partida', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const r = await c.call('POST', `/g/seasons/${season.id}/sessions`, {
      playerIds: [ana.id], initialBuyIn: 100, balances: [{ playerId: beto.id, amount: 5 }],
    }, 'saldo-ajeno');
    expect(r.status).toBe(404);
  });
  it('un pago baja la deuda del pagador y el crédito del acreedor, y se puede deshacer', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const payment = await c.idem('/g/payments', { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 20, note: ' efectivo ' });
    expect(payment).toMatchObject({ amount: 20, note: 'efectivo', fromPlayer: { id: beto.id }, toPlayer: { id: ana.id } });
    expect((await c.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance)).toEqual([30, -30]);
    expect(await c.ok('GET', '/g/payments')).toHaveLength(1);
    await c.ok('DELETE', `/g/payments/${payment.id}`);
    expect((await c.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance)).toEqual([50, -50]);
    expect((await c.call('DELETE', `/g/payments/${payment.id}`)).status).toBe(404);
  });
  it('valida pagos: excesos, sentido incorrecto y mismo jugador', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const pay = (from: string, to: string, amount: number, key: string) =>
      c.call('POST', '/g/payments', { fromPlayerId: from, toPlayerId: to, amount }, key);
    expect((await pay(beto.id, ana.id, 51, 'pago-exceso')).body.error).toBe('invalid_payment');
    expect((await pay(ana.id, beto.id, 10, 'pago-al-reves')).body.error).toBe('invalid_payment');
    expect((await pay(ana.id, ana.id, 10, 'pago-mismo')).body.error).toBe('invalid_payment');
    expect((await pay(beto.id, ana.id, 0.001, 'pago-decimales')).status).toBe(422);
  });
  it('la reproducción con la misma Idempotency-Key no duplica el pago', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const body = { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 10 };
    await c.ok('POST', '/g/payments', body, 'pago-repetido');
    await c.ok('POST', '/g/payments', body, 'pago-repetido');
    expect(await c.ok('GET', '/g/payments')).toHaveLength(1);
  });
});

describe('backup', () => {
  const legacy = () => ({
    exportedAt: '2026-01-01T00:00:00.000Z',
    appVersion: '1.1.0',
    data: {
      poker_players: [
        { id: 'p1', name: 'Ana', createdAt: '2025-01-01T00:00:00.000Z', adjustments: [{ id: 'a', description: 'viejo', amount: 15, date: '2025-01-01T00:00:00.000Z' }] },
        { id: 'p2', name: 'Beto', createdAt: '2025-01-01T00:00:00.000Z' },
      ],
      poker_seasons: [
        { id: 't1', name: 'Temporada 1', createdAt: '2025-01-01T00:00:00.000Z', closedAt: null, status: 'active' },
      ],
      poker_sessions: [
        {
          id: 's1', name: 'Viernes', createdAt: '2025-02-01T22:00:00.000Z', closedAt: '2025-02-02T02:00:00.000Z', status: 'closed', seasonId: 't1',
          participants: [
            { playerId: 'p1', name: 'Ana', finalAmount: 150, buys: [{ amount: 100, timestamp: '2025-02-01T22:00:00.000Z' }] },
            { playerId: 'p9', name: 'Fantasma', finalAmount: 50, buys: [{ amount: 100, timestamp: '2025-02-01T22:00:00.000Z' }, { amount: 0, timestamp: 'x' }] },
          ],
        },
        { id: 's2', name: 'Sin temporada', createdAt: '2025-03-01T22:00:00.000Z', status: 'closed', participants: [] },
      ],
      poker_debts: [
        { id: 'd1', fromPlayer: { id: 'p9', name: 'Fantasma' }, toPlayer: { id: 'p1', name: 'Ana' }, sessionId: 's1', sessionName: 'Viernes', originalAmount: 50, pendingAmount: 30, status: 'partial', payments: [{ amount: 20, date: '2025-03-01T00:00:00.000Z', note: '' }], createdAt: '2025-02-02T02:00:00.000Z', isConsolidated: false },
        { id: 'd2', fromPlayer: { id: 'p2', name: 'Beto' }, toPlayer: { id: 'p1', name: 'Ana' }, sessionId: 'ajuste_previo', sessionName: 'Asado', originalAmount: 40.555, pendingAmount: 40.555, status: 'pending', payments: [], createdAt: '2025-01-01T00:00:00.000Z', isConsolidated: false },
        { id: 'd3', fromPlayer: { id: 'p2', name: 'Beto' }, toPlayer: { id: 'p9', name: 'Fantasma' }, sessionId: 'neteado', sessionName: 'Deuda consolidada', originalAmount: 5, pendingAmount: 5, status: 'pending', payments: [], createdAt: '2025-01-01T00:00:00.000Z', isConsolidated: true },
        { id: 'd4', fromPlayer: { id: 'p9', name: 'Fantasma' }, toPlayer: { id: 'p2', name: 'Beto' }, sessionId: 'borrada', sessionName: 'Partida borrada', originalAmount: 7, pendingAmount: 7, status: 'pending', payments: [], createdAt: '2025-01-01T00:00:00.000Z', isConsolidated: false },
        { id: 'd5', fromPlayer: { id: 'p1', name: 'Ana' }, toPlayer: { id: 'p1', name: 'Ana' }, sessionId: 's1', sessionName: 'Inválida', originalAmount: 1, pendingAmount: 1, status: 'pending', payments: [], createdAt: '2025-01-01T00:00:00.000Z', isConsolidated: false },
      ],
    },
  });

  it('dryRun informa sin cambiar datos', async () => {
    const { c } = await withGroup();
    const r = await c.ok('POST', '/g/backup/import?dryRun=true', legacy());
    expect(r).toMatchObject({ dryRun: true, counts: { players: 3, archivedPlayers: 1, adjustments: 1, seasons: 2, sessions: 2, debts: 4 } });
    expect(r.warnings.join('|')).toContain('partida inexistente');
    expect(await c.ok('GET', '/g/players')).toEqual([]);
  });
  it('importa datos legacy, con sus centinelas y fantasmas', async () => {
    const { c } = await withGroup();
    await c.ok('POST', '/g/players', { name: 'Se reemplaza' });
    await c.ok('POST', '/g/backup/import', legacy());
    const players = await c.ok('GET', '/g/players?includeArchived=true');
    expect(players.map((p: { name: string; archivedAt: string | null }) => [p.name, !!p.archivedAt]).sort())
      .toEqual([['Ana', false], ['Beto', false], ['Fantasma', true]]);
    expect(players.every((p: { id: string }) => !['p1', 'p2', 'p9'].includes(p.id))).toBe(true);

    const debts = await c.ok('GET', '/g/debts');
    const by = (label: string) => debts.find((d: { label: string }) => d.label === label);
    expect(by('Viernes')).toMatchObject({ sourceType: 'session', status: 'partial', pendingAmount: 30 });
    expect(by('Viernes').payments).toHaveLength(1);
    expect(by('Asado')).toMatchObject({ sourceType: 'manual', sessionId: null, pendingAmount: 40.56, manualAmount: 40.56 });
    expect(by('Deuda consolidada')).toMatchObject({ sourceType: 'consolidated', isConsolidated: true });
    expect(by('Partida borrada')).toMatchObject({ sourceType: 'consolidated', isConsolidated: true });
    expect(by('Inválida')).toBeUndefined();

    const seasons = await c.ok('GET', '/g/seasons');
    expect(seasons).toHaveLength(2);
    expect(seasons.filter((s: { status: string }) => s.status === 'active')).toHaveLength(1);

    const ana = players.find((p: { name: string }) => p.name === 'Ana');
    expect(await c.ok('GET', `/g/players/${ana.id}/stats`)).toMatchObject({ sessionBalance: 50, adjustmentsTotal: 15 });
  });
  it('rechaza más de una temporada activa, sin cambiar datos', async () => {
    const { c } = await withGroup();
    const bad = legacy();
    bad.data.poker_seasons.push({ ...bad.data.poker_seasons[0], id: 't2' });
    expect((await c.call('POST', '/g/backup/import', bad)).body.error).toBe('import_multiple_active_seasons');
    expect((await c.ok('GET', '/g/seasons'))[0].name).toBe('Temporada 1');
  });
  it('rechaza un archivo sin las claves esperadas', async () => {
    const { c } = await withGroup();
    expect((await c.call('POST', '/g/backup/import', { data: { players: [] } })).status).toBe(400);
  });
  it('sin poker_seasons crea Temporada 1 activa', () => {
    const plan = planImport({ poker_players: [], poker_sessions: [], poker_debts: [] });
    expect(plan.seasons.map(s => [s.name, s.status])).toEqual([['Temporada 1', 'active']]);
  });
  it('importar el mismo backup en dos grupos no colisiona', async () => {
    const { c: a } = await withGroup('ana');
    const { c: b } = await withGroup('beto');
    await a.ok('POST', '/g/backup/import', legacy());
    await b.ok('POST', '/g/backup/import', legacy());
  });
  it('exportar e importar es ida y vuelta', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto);
    await c.ok('POST', '/g/debts/manual', { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 25 });
    await c.ok('DELETE', `/g/players/${beto.id}`);
    const ranking = await c.ok('GET', '/g/ranking');
    const file = await c.ok('GET', '/g/backup/export');
    expect(Object.keys(file.data).sort()).toEqual(['poker_debts', 'poker_players', 'poker_seasons', 'poker_sessions']);

    const { c: copy } = await withGroup('otro');
    await copy.ok('POST', '/g/backup/import', file);
    const again = await copy.ok('GET', '/g/ranking');
    const key = (r: { name: string; totalBalance: number; totalGames: number }) => [r.name, r.totalBalance, r.totalGames];
    expect(again.map(key)).toEqual(ranking.map(key));
    const [debt] = await copy.ok('GET', '/g/debts');
    expect(debt).toMatchObject({ manualAmount: 25, pendingAmount: 25, sourceType: 'manual' });
  });
});

describe('sala remota', () => {
  /** Un JPEG mínimo válido para el servidor (firma + relleno): no hace falta una imagen real. */
  const jpeg = (fill = 1, size = 300) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size, fill)]);
  const b64 = (b: Buffer) => `data:image/jpeg;base64,${b.toString('base64')}`;

  async function room() {
    process.env.LIVE_PHOTO_MIN_MS = '0';
    const { c: admin, group } = await withGroup('master');
    const { season, ana, beto } = await seed(admin);
    // Dos remotos (lectores) con su jugador: los de la mesa son Ana y Beto, que no tienen usuario.
    const remote = async (sub: string, name: string) => {
      const c = await login(sub);
      await c.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
      c.groupId = group.id;
      const player = await c.ok('POST', '/g/me/player', { name });
      return { c, player };
    };
    const r1 = await remote('remoto1', 'Remoto Uno');
    const r2 = await remote('remoto2', 'Remoto Dos');
    const session = await admin.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id, r1.player.id, r2.player.id], initialBuyIn: 100 });
    const opened = await admin.idem(`/g/sessions/${session.id}/live`, {});
    return { admin, group, r1, r2, session, code: opened.code as string, roomId: opened.id as string };
  }

  it('solo un administrador abre la sala; es una por partida y se encuentra desde la partida', async () => {
    const { admin, r1, session, code } = await room();
    expect((await r1.c.call('POST', `/g/sessions/${session.id}/live`, {}, 'abrir-lector')).body.error).toBe('read_only');
    expect((await admin.idem(`/g/sessions/${session.id}/live`, {})).code).toBe(code);
    const found = await r1.c.ok('GET', `/g/sessions/${session.id}/live`);
    expect(found.room).toMatchObject({ code, status: 'open' });
    expect(code).toMatch(/^[a-z2-9]{8}$/);
  });

  it('entrar a la sala exige tener jugador; antes de entrar no se ve nada de las fotos', async () => {
    const { admin, r1, code } = await room();
    const view0 = await r1.c.ok('GET', `/g/live/${code}`);
    expect(view0).toMatchObject({ me: null, board: [], myCards: [], handNo: 1 });
    await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'board', image: b64(jpeg()) });
    expect((await r1.c.ok('GET', `/g/live/${code}`)).board).toEqual([]);
    const joined = await r1.c.ok('POST', `/g/live/${code}/join`);
    expect(joined.me).toMatchObject({ playerId: r1.player.id, operator: true });
    expect(joined.board).toHaveLength(1);
    expect(joined.members.map((m: { name: string }) => m.name)).toContain('Remoto Uno');
    const outsider = await login('sinjugador');
    await outsider.ok('POST', '/groups/join', { inviteCode: (await admin.ok('GET', '/g')).inviteCode });
    outsider.groupId = admin.groupId;
    expect((await outsider.call('POST', `/g/live/${code}/join`, {}, 'sin-jugador')).body.error).toBe('no_player');
  });

  it('las fotos de la mesa las ve la sala; las cartas de cada remoto, solo él y quien las sacó', async () => {
    const { admin, r1, r2, code } = await room();
    await r1.c.ok('POST', `/g/live/${code}/join`);
    await r2.c.ok('POST', `/g/live/${code}/join`);
    const table = await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'board', image: b64(jpeg(2)) });
    const hole = await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'hole', playerId: r1.player.id, image: b64(jpeg(3)) });

    // La de la mesa: los dos remotos reciben la misma imagen, sin caché.
    for (const r of [r1, r2]) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/groups/${r.c.groupId}/live/${code}/photos/${table.id}`, headers: { authorization: `Bearer ${r.c.token}` } });
      expect([res.statusCode, res.headers['content-type'], res.headers['cache-control']]).toEqual([200, 'image/jpeg', 'no-store']);
      expect(res.rawPayload.equals(jpeg(2))).toBe(true);
    }
    // Las cartas de r1: él las ve y r2 no (ni en su vista ni pidiéndolas).
    expect((await r1.c.ok('GET', `/g/live/${code}`)).myCards.map((p: { id: string }) => p.id)).toEqual([hole.id]);
    expect((await r2.c.ok('GET', `/g/live/${code}`)).myCards).toEqual([]);
    const status = async (c: Client, id: string) => (await app.inject({
      method: 'GET', url: `/api/v1/groups/${c.groupId}/live/${code}/photos/${id}`, headers: { authorization: `Bearer ${c.token}` },
    })).statusCode;
    expect(await status(r2.c, hole.id)).toBe(404);
    expect(await status(r1.c, hole.id)).toBe(200);
    expect(await status(admin, hole.id)).toBe(200);
    // Una segunda foto de las mismas cartas reemplaza a la primera.
    const hole2 = await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'hole', playerId: r1.player.id, image: b64(jpeg(4)) });
    expect((await r1.c.ok('GET', `/g/live/${code}`)).myCards.map((p: { id: string }) => p.id)).toEqual([hole2.id]);
    expect(await status(r1.c, hole.id)).toBe(404);
    expect((await admin.ok('GET', `/g/live/${code}`)).sent).toEqual({ [r1.player.id]: 1 });
  });

  it('valida las fotos; cualquiera de la sala las manda y pasa de mano, quien no entró no', async () => {
    const { admin, r1, r2, code } = await room();
    const post = (c: Client, body: object) => c.call('POST', `/g/live/${code}/photos`, body, undefined);
    const img = (n = 1) => ({ kind: 'board', image: b64(jpeg(n)) });
    // Sin haber entrado a la sala no se puede mandar nada.
    expect((await post(r1.c, img())).body.error).toBe('not_in_room');
    expect((await r1.c.call('POST', `/g/live/${code}/new-hand`, {}, 'nm-sin-entrar')).body.error).toBe('not_in_room');
    await r1.c.ok('POST', `/g/live/${code}/join`);
    await r2.c.ok('POST', `/g/live/${code}/join`);

    expect((await post(admin, { kind: 'board', image: Buffer.alloc(300, 7).toString('base64') })).body.error).toBe('invalid_photo');
    expect((await post(admin, { kind: 'board', image: b64(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300)])) })).body.error).toBe('invalid_photo');
    expect((await post(admin, { kind: 'board', image: b64(jpeg(1, 420_000)) })).body.error).toBe('photo_too_large');
    expect((await post(admin, { kind: 'hole', image: b64(jpeg()) })).body.error).toBe('invalid_photo');
    expect((await post(admin, { kind: 'board', playerId: r1.player.id, image: b64(jpeg()) })).body.error).toBe('invalid_photo');
    expect((await post(admin, { kind: 'hole', playerId: 'nadie', image: b64(jpeg()) })).body.error).toBe('not_in_room');

    // Un remoto manda la foto de la mesa y las cartas del otro remoto; solo el dueño las recibe.
    expect((await post(r1.c, img())).status).toBe(200);
    const hole = await r1.c.ok('POST', `/g/live/${code}/photos`, { kind: 'hole', playerId: r2.player.id, image: b64(jpeg(5)) });
    expect((await r2.c.ok('GET', `/g/live/${code}`)).myCards.map((p: { id: string }) => p.id)).toEqual([hole.id]);
    expect((await r1.c.ok('GET', `/g/live/${code}`)).myCards).toEqual([]);
    const status = async (c: Client, id: string) => (await app.inject({
      method: 'GET', url: `/api/v1/groups/${c.groupId}/live/${code}/photos/${id}`, headers: { authorization: `Bearer ${c.token}` },
    })).statusCode;
    expect(await status(r1.c, hole.id)).toBe(200); // quien la sacó
    expect(await status(r2.c, hole.id)).toBe(200); // el dueño
    // Y cualquiera pasa de mano.
    expect((await r2.c.ok('POST', `/g/live/${code}/new-hand`)).handNo).toBe(2);

    // Ritmo y tope por mano.
    process.env.LIVE_PHOTO_MIN_MS = '60000';
    expect((await post(r1.c, img())).body.error).toBe('too_fast');
    process.env.LIVE_PHOTO_MIN_MS = '0';
    for (let i = 0; i < 12; i++) expect((await post(admin, img(i))).status).toBe(200);
    expect((await post(admin, img(9))).body.error).toBe('too_many_photos');
  });

  it('nueva mano borra las fotos; cerrar la partida cierra la sala y borra todo', async () => {
    const { admin, r1, session, code, roomId } = await room();
    await r1.c.ok('POST', `/g/live/${code}/join`);
    const photo = await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'board', image: b64(jpeg()) });
    const next = await admin.ok('POST', `/g/live/${code}/new-hand`);
    expect([next.handNo, next.board]).toEqual([2, []]);
    expect((await app.inject({ method: 'GET', url: `/api/v1/groups/${r1.c.groupId}/live/${code}/photos/${photo.id}`, headers: { authorization: `Bearer ${r1.c.token}` } })).statusCode).toBe(404);
    await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'board', image: b64(jpeg()) });
    expect((await conn.pool.query('select count(*)::int as n from live_photos')).rows[0].n).toBe(1);

    await admin.ok('PATCH', `/g/sessions/${session.id}/participants/${(await admin.ok('GET', '/g/players'))[0].id}`, { finalAmount: 100 });
    // Cerrar la partida cierra la sala y no deja ninguna foto.
    const ref = await admin.ok('GET', `/g/sessions/${session.id}`);
    for (const p of ref.participants) await admin.ok('PATCH', `/g/sessions/${session.id}/participants/${p.playerId}`, { finalAmount: 100 });
    await admin.idem(`/g/sessions/${session.id}/close`);
    expect((await conn.pool.query('select status from live_rooms where id = $1', [roomId])).rows[0].status).toBe('closed');
    expect((await conn.pool.query('select count(*)::int as n from live_photos')).rows[0].n).toBe(0);
    expect((await r1.c.call('POST', `/g/live/${code}/join`, {}, 'join-cerrada')).body.error).toBe('room_closed');
    expect((await admin.ok('GET', `/g/sessions/${session.id}/live`)).room).toBeNull();
  });

  it('borrar la partida borra la sala; una sala de otro grupo no se ve', async () => {
    const { admin, session, code } = await room();
    const { c: other } = await withGroup('otro');
    expect((await other.call('GET', `/g/live/${code}`)).status).toBe(404);
    await admin.ok('DELETE', `/g/sessions/${session.id}`);
    expect((await conn.pool.query('select count(*)::int as n from live_rooms')).rows[0].n).toBe(0);
  });

  it('el canal de la sala no se mezcla con el de la mesa, y solo entran sus miembros', async () => {
    const { admin, group, r1, r2, code, roomId } = await room();
    const url = (c: Client, extra = '') => `/api/v1/groups/${group.id}/table/ws${extra}`;
    const open = async (c: Client, extra = '') => {
      const ws = await app.injectWS(url(c, extra));
      const first = new Promise<{ type: string }>(resolve => ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()))));
      ws.send(JSON.stringify({ type: 'auth', token: c.token }));
      return { ws, first: await Promise.race([first, new Promise<{ type: string }>(r => setTimeout(() => r({ type: 'timeout' }), 1500))]) };
    };
    await r1.c.ok('POST', `/g/live/${code}/join`);
    // r2 no entró a la sala: se le cierra el socket de la sala, pero puede usar el de la mesa del grupo.
    const closed = await app.injectWS(url(r2.c, `?room=${roomId}`));
    const code2 = new Promise<number>(resolve => closed.once('close', (c: number) => resolve(c)));
    closed.send(JSON.stringify({ type: 'auth', token: r2.c.token }));
    expect(await code2).toBe(4403);
    const group2 = await open(r2.c);
    expect(group2.first.type).toBe('ready');
    const live = await open(r1.c, `?room=${roomId}`);
    expect(live.first.type).toBe('ready');
    // Una foto avisa solo a la sala.
    const inRoom = new Promise<{ type: string }>(resolve => live.ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()))));
    let leaked = 0;
    group2.ws.on('message', () => { leaked++; });
    await admin.ok('POST', `/g/live/${code}/photos`, { kind: 'board', image: b64(jpeg()) });
    expect((await inRoom).type).toBe('changed');
    await new Promise(r => setTimeout(r, 200));
    expect(leaked).toBe(0);
    live.ws.close();
    group2.ws.close();
  });
});

describe('contrato', () => {
  it('docs/openapi.yaml coincide con el contrato', async () => {
    expect(readFileSync(openapiPath, 'utf8')).toBe(await generateOpenApi());
  });
  it('health no requiere autenticación', async () => {
    expect((await app.inject({ url: '/health' })).json()).toEqual({ ok: true });
  });
});

describe('roles', () => {
  /** Master con grupo y un miembro de solo lectura. */
  async function withReader() {
    const { c: master, group } = await withGroup('master');
    const reader = await login('lector');
    await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    reader.groupId = group.id;
    return { master, reader, group };
  }

  it('un lector no puede anular ni reactivar una partida', async () => {
    const { master, reader } = await withReader();
    const { season, ana, beto } = await seed(master);
    const id = await closedSession(master, season.id, ana, beto);
    expect((await reader.call('POST', `/g/sessions/${id}/void`, {}, 'lector-anular')).body.error).toBe('read_only');
    expect((await reader.call('POST', `/g/sessions/${id}/restore`, {}, 'lector-restaurar')).body.error).toBe('read_only');
  });
  it('el primer login es master, incluso con dos simultáneos', async () => {
    const results = await Promise.all(['uno', 'dos', 'tres'].map(async sub => (await login(sub)).ok('GET', '/me')));
    expect(results.map(r => r.user.role).sort()).toEqual(['master', 'reader', 'reader']);
    expect((await login('uno')).token).toBeTruthy();
    const { rows } = await conn.pool.query(`select count(*)::int as n from users where role = 'master'`);
    expect(rows[0].n).toBe(1);
  });
  it('la migración hace master al usuario más antiguo', async () => {
    const migration = readdirSync(resolve(__dirname, '../../../db/migrations')).find(f => f.startsWith('0001_')) as string;
    const backfill = readFileSync(resolve(__dirname, '../../../db/migrations', migration), 'utf8')
      .split('--> statement-breakpoint').at(-1) as string;
    await conn.pool.query(`insert into users (id, google_sub, email, name, created_at) values
      ('nuevo', 'a', 'a@x.com', 'A', '2026-02-01'), ('viejo', 'b', 'b@x.com', 'B', '2026-01-01')`);
    await conn.pool.query(backfill);
    const { rows } = await conn.pool.query('select id, role from users order by id');
    expect(rows).toEqual([{ id: 'nuevo', role: 'reader' }, { id: 'viejo', role: 'master' }]);
  });
  it('solo el master administra roles', async () => {
    const { reader } = await withReader();
    const admin = await login('admin');
    await promote('admin');
    for (const c of [reader, admin]) {
      expect((await c.call('GET', '/admin/users')).body.error).toBe('not_master');
      expect((await c.call('POST', '/admin/admins', { email: 'x@x.com' })).body.error).toBe('not_master');
    }
  });
  it('nombrado por email antes del primer login, sin distinguir mayúsculas', async () => {
    const master = await login('master');
    const r = await master.ok('POST', '/admin/admins', { email: 'Nuevo@X.com' });
    expect(r.pending.map((p: { email: string }) => p.email)).toEqual(['nuevo@x.com']);
    const nuevo = await login('nuevo');
    expect((await nuevo.ok('GET', '/me')).user.role).toBe('admin');
    expect((await master.ok('GET', '/admin/users')).pending).toEqual([]);
    await nuevo.ok('POST', '/groups', { name: 'Suyo' });
  });
  it('promover después del login y quitar rigen en la request siguiente', async () => {
    const { master, reader, group } = await withReader();
    expect((await reader.call('POST', '/g/players', { name: 'x' })).body.error).toBe('read_only');
    await master.ok('POST', '/admin/admins', { email: 'lector@x.com' });
    await reader.ok('POST', '/g/players', { name: 'x' });
    expect((await reader.ok('GET', '/g')).inviteCode).toBe(group.inviteCode);
    await master.ok('DELETE', '/admin/admins/lector%40x.com');
    expect((await reader.call('POST', '/g/players', { name: 'y' })).body.error).toBe('read_only');
  });
  it('el master no se puede quitar, y quitar a alguien inexistente da 404', async () => {
    const master = await login('master');
    expect((await master.call('DELETE', '/admin/admins/master%40x.com')).body.error).toBe('cannot_remove_master');
    expect((await master.call('DELETE', '/admin/admins/nadie%40x.com')).status).toBe(404);
  });
  it('rechaza un email inválido', async () => {
    const master = await login('master');
    expect((await master.call('POST', '/admin/admins', { email: 'sin-arroba' })).status).toBe(400);
  });
  it('solo lectura no crea grupos ni ve invitación, emails ni backup', async () => {
    const { reader } = await withReader();
    expect((await reader.call('POST', '/groups', { name: 'x' })).body.error).toBe('read_only');
    const group = await reader.ok('GET', '/g');
    expect(group.inviteCode).toBeNull();
    expect(group.members[0].email).toBeUndefined();
    expect((await reader.call('GET', '/g/backup/export')).body.error).toBe('read_only');
  });
  it('solo lectura recibe 403 en todas las escrituras y puede leer', async () => {
    const { master, reader } = await withReader();
    const { season, ana, beto } = await seed(master);
    const sessionId = await closedSession(master, season.id, ana, beto);
    for (const [method, path] of [
      ['PATCH', '/g'], ['POST', '/g/invite/rotate'],
      ['POST', '/g/players'], ['PATCH', `/g/players/${ana.id}`], ['DELETE', `/g/players/${ana.id}`],
      ['POST', `/g/players/${ana.id}/unarchive`], ['POST', `/g/players/${ana.id}/user`],
      ['POST', `/g/players/${ana.id}/adjustments`], ['PATCH', `/g/players/${ana.id}/adjustments/x`], ['DELETE', `/g/players/${ana.id}/adjustments/x`],
      ['POST', '/g/seasons'], ['PATCH', `/g/seasons/${season.id}`], ['DELETE', `/g/seasons/${season.id}`],
      ['POST', `/g/seasons/${season.id}/close`], ['POST', `/g/seasons/${season.id}/reopen`], ['POST', `/g/seasons/${season.id}/sessions`],
      ['DELETE', `/g/sessions/${sessionId}`], ['POST', `/g/sessions/${sessionId}/buys`], ['POST', `/g/sessions/${sessionId}/close`],
      ['POST', `/g/sessions/${sessionId}/participants`], ['PATCH', `/g/sessions/${sessionId}/participants/${ana.id}`], ['DELETE', `/g/sessions/${sessionId}/participants/${ana.id}`],
      ['DELETE', `/g/sessions/${sessionId}/buys/x`],
      ['POST', '/g/debts/manual'], ['DELETE', '/g/debts/manual/x'], ['POST', '/g/debts/mark-paid'],
      ['POST', '/g/debts/x/payments'], ['POST', '/g/debts/x/mark-paid'], ['POST', '/g/debts/renet'], ['POST', '/g/debts/renet/undo'],
      ['POST', '/g/backup/import'],
    ] as const) {
      const r = await reader.call(method, path, method === 'DELETE' ? undefined : {}, 'clave-de-prueba');
      expect([path, r.status, r.body.error]).toEqual([path, 403, 'read_only']);
    }
    for (const path of ['/g', '/g/players', '/g/seasons', `/g/sessions/${sessionId}`, '/g/debts', '/g/ranking', `/g/players/${ana.id}/stats`]) {
      await reader.ok('GET', path);
    }
  });
  it('todas las rutas de escritura del OpenAPI están bajo alguna regla de permisos', async () => {
    const paths = parse(await generateOpenApi()).paths as Record<string, Record<string, unknown>>;
    const open = Object.entries(paths)
      .flatMap(([path, ops]) => Object.keys(ops).filter(m => m !== 'get').map(m => `${m.toUpperCase()} ${path}`))
      .filter(route => !route.includes('/admin/') && !route.includes('/auth/'));
    const { master, reader } = await withReader();
    const { ana } = await seed(master);
    const allowed = new Set([
      'POST /api/v1/groups/join', 'DELETE /api/v1/groups/{groupId}/members/me', 'POST /api/v1/groups/{groupId}/me/player',
      // Pagos: se autorizan por dueño del pagador, no por rol (ver test de pagos a nombre propio).
      'POST /api/v1/groups/{groupId}/payments', 'DELETE /api/v1/groups/{groupId}/payments/{paymentId}',
      // La mesa online la juega cualquier miembro.
      ...['join', 'leave', 'ping', 'start', 'deal', 'action', 'rebuy', 'reveal', 'close'].map(a => `POST /api/v1/groups/{groupId}/table/${a}`),
      // Sala remota: la ven y entran los miembros; armarla y mandar fotos lo decide cada ruta (administrador u operador).
      'POST /api/v1/groups/{groupId}/sessions/{id}/live',
      ...['join', 'photos', 'new-hand', 'close'].map(a => `POST /api/v1/groups/{groupId}/live/{code}/${a}`),
      'POST /api/v1/groups/{groupId}/live/{code}/operators/{userId}',
    ]);
    for (const route of open.filter(r => !allowed.has(r))) {
      const [method, path] = route.split(' ');
      const url = path.replace('/api/v1', '').replace('{groupId}', reader.groupId).replace(/\{\w+\}/g, ana.id);
      const r = await reader.call(method as 'POST', url, method === 'DELETE' ? undefined : {}, 'clave-de-prueba');
      expect([route, r.body.error]).toEqual([route, 'read_only']);
    }
  });
  it('un admin entra a un grupo ajeno; solo lectura sigue con 403', async () => {
    const { group } = await withGroup('dueño');
    const admin = await login('admin');
    const reader = await login('lector');
    await promote('admin');
    admin.groupId = group.id;
    reader.groupId = group.id;
    expect((await admin.ok('GET', '/groups')).map((g: { id: string }) => g.id)).toEqual([group.id]);
    await admin.ok('POST', '/g/players', { name: 'x' });
    expect((await admin.ok('GET', '/g')).isMember).toBe(false);
    expect((await admin.call('DELETE', '/g/members/me')).body.error).toBe('not_a_member');
    expect(await reader.ok('GET', '/groups')).toEqual([]);
    expect((await reader.call('GET', '/g')).status).toBe(403);
  });
});

describe('nick', () => {
  async function withReader() {
    const { c: master, group } = await withGroup('master');
    const reader = await login('lector');
    await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    reader.groupId = group.id;
    return { master, reader, group };
  }
  const myGroup = async (c: Client) => (await c.ok('GET', '/me')).groups[0];

  it('elige un jugador libre, y queda visible en /me y en la lista', async () => {
    const { master, reader } = await withReader();
    const { ana } = await seed(master);
    expect((await myGroup(reader)).playerId).toBeNull();
    expect((await reader.ok('POST', '/g/me/player', { playerId: ana.id })).linked).toBe(true);
    expect((await myGroup(reader)).playerId).toBe(ana.id);
    expect((await reader.call('POST', '/g/me/player', { name: 'Otro' })).body.error).toBe('already_linked');
  });
  it('crea un jugador nuevo; un nombre activo repetido da 409', async () => {
    const { master, reader } = await withReader();
    await seed(master);
    expect((await reader.call('POST', '/g/me/player', { name: 'ANA' })).body.error).toBe('player_name_taken');
    const created = await reader.ok('POST', '/g/me/player', { name: 'Lector' });
    expect((await myGroup(reader)).playerId).toBe(created.id);
  });
  it('dos usuarios que reclaman el mismo jugador: uno recibe 409', async () => {
    const { master, reader, group } = await withReader();
    const { ana } = await seed(master);
    const other = await login('otro');
    await other.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    other.groupId = group.id;
    const results = await Promise.all([reader, other].map(c => c.call('POST', '/g/me/player', { playerId: ana.id })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)?.body.error).toBe('player_taken');
  });
  it('rechaza un jugador archivado, de otro grupo, y pedir nada o las dos cosas', async () => {
    const { master, reader } = await withReader();
    const { ana, beto } = await seed(master);
    await master.ok('POST', `/g/players/${beto.id}/adjustments`, { description: 'x', amount: 1 });
    await master.ok('DELETE', `/g/players/${beto.id}`);
    expect((await reader.call('POST', '/g/me/player', { playerId: beto.id })).body.error).toBe('player_archived');
    expect((await reader.call('POST', '/g/me/player', { playerId: 'ajeno' })).status).toBe(404);
    expect((await reader.call('POST', '/g/me/player', {})).body.error).toBe('invalid_claim');
    expect((await reader.call('POST', '/g/me/player', { playerId: ana.id, name: 'x' })).body.error).toBe('invalid_claim');
  });
  it('archivar conserva la asociación; borrar la libera', async () => {
    const { master, reader } = await withReader();
    const { season, ana, beto } = await seed(master);
    await reader.ok('POST', '/g/me/player', { playerId: beto.id });
    await closedSession(master, season.id, ana, beto);
    await master.ok('DELETE', `/g/players/${beto.id}`);
    expect((await myGroup(reader)).playerId).toBe(beto.id);

    const { reader: other } = await withReader2(master);
    const created = await other.ok('POST', '/g/me/player', { name: 'Sin historial' });
    await master.ok('DELETE', `/g/players/${created.id}`);
    expect((await myGroup(other)).playerId).toBeNull();
  });
  async function withReader2(master: Client) {
    const { inviteCode } = await master.ok('GET', '/g');
    const reader = await login('segundo');
    await reader.ok('POST', '/groups/join', { inviteCode });
    reader.groupId = master.groupId;
    return { reader };
  }
  it('un admin corrige la asociación, incluso quitarla o moverla', async () => {
    const { master, reader } = await withReader();
    const { ana, beto } = await seed(master);
    const { id } = (await reader.ok('GET', '/me')).user;
    await reader.ok('POST', '/g/me/player', { playerId: ana.id });
    await master.ok('POST', `/g/players/${beto.id}/user`, { userId: id });
    expect((await myGroup(reader)).playerId).toBe(beto.id);
    expect((await master.ok('GET', '/g/players')).find((p: { id: string }) => p.id === ana.id).linked).toBe(false);
    await master.ok('POST', `/g/players/${beto.id}/user`, { userId: null });
    expect((await myGroup(reader)).playerId).toBeNull();
    const stranger = await login('ajeno');
    const strangerId = (await stranger.ok('GET', '/me')).user.id;
    expect((await master.call('POST', `/g/players/${beto.id}/user`, { userId: strangerId })).body.error).toBe('invalid_user');
  });
  it('importar conserva la asociación si coincide el nombre y avisa si se pierde', async () => {
    const { master, reader } = await withReader();
    const { ana } = await seed(master);
    await reader.ok('POST', '/g/me/player', { playerId: ana.id });
    const other = (await withReader2(master)).reader;
    await other.ok('POST', '/g/me/player', { name: 'NoEstá' });
    const data = { poker_players: [{ id: 'p1', name: 'ana', createdAt: '2025-01-01T00:00:00.000Z' }], poker_sessions: [], poker_debts: [] };

    const preview = await master.ok('POST', '/g/backup/import?dryRun=true', { data });
    expect(preview.warnings.join()).toContain('1 usuario(s) pierden la asociación');
    expect((await myGroup(reader)).playerId).toBe(ana.id);

    await master.ok('POST', '/g/backup/import', { data });
    const players = await master.ok('GET', '/g/players');
    expect((await myGroup(reader)).playerId).toBe(players[0].id);
    expect((await myGroup(other)).playerId).toBeNull();
    expect(JSON.stringify(await master.ok('GET', '/g/backup/export'))).not.toContain('userId');
  });
});

describe('conexión', () => {
  it('sobrevive a que la base corte una conexión inactiva', async () => {
    const other = connect(url);
    const { rows } = await other.pool.query('SELECT pg_backend_pid() AS pid');
    await conn.pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    await new Promise(r => setTimeout(r, 200));
    expect((await other.pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
    await other.pool.end();
  });
});

describe('mesa online', () => {
  async function setup(extra = 0) {
    const { c: a, group } = await withGroup('master');
    const clients: Client[] = [a];
    for (let i = 0; i <= extra; i++) {
      const c = await login(i === 0 ? 'lector' : `extra${i}`);
      await c.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
      c.groupId = group.id;
      clients.push(c);
    }
    const pid: Record<number, string> = {};
    for (const [i, c] of clients.entries()) pid[i] = (await c.ok('POST', '/g/me/player', { name: `J${i}` })).id;
    const byPlayer = (id: string) => clients[Object.values(pid).indexOf(id)];
    return { a, b: clients[1], clients, pid, byPlayer };
  }
  const view = (c: Client) => c.ok('GET', '/g/table');
  const act = (c: Client, v: { version: number }, action: object) => c.ok('POST', '/g/table/action', { version: v.version, action });

  it('reparte quien inició la partida o un administrador; si esa persona se va, cualquiera sentado', async () => {
    const { a: admin, clients: [, host, other], byPlayer } = await setup(1);
    for (const c of [admin, host, other]) await c.ok('POST', '/g/table/join');
    let v = await host.idem('/g/table/start', {});
    const finish = async () => {
      for (let i = 0; v.hand.street !== 'done'; i++) {
        if (i > 10) throw new Error('mano infinita');
        v = await act(byPlayer(v.hand.toActPlayerId), v, { type: 'fold' });
      }
    };
    await finish();
    // Todos ven quién reparte; solo él y el administrador pueden.
    const [hostView, otherView, adminView] = await Promise.all([host, other, admin].map(view));
    expect([hostView.host, hostView.canHost, otherView.canHost, adminView.canHost]).toEqual(['J1', true, false, true]);
    expect((await other.call('POST', '/g/table/deal')).body.error).toBe('not_host');
    // Cerrar la partida, igual: otro sentado no puede.
    expect((await other.call('POST', '/g/table/close', {}, 'close-not-host-1')).body.error).toBe('not_host');
    v = await host.ok('POST', '/g/table/deal');
    await finish();
    v = await admin.ok('POST', '/g/table/deal');
    await finish();
    // Quien inició se desconecta: para no trabar la partida, reparte cualquiera que esté sentado.
    expect([hostView.isHost, otherView.isHost]).toEqual([true, false]);
    await conn.pool.query(`update poker_tables set host_seen_at = now() - interval '5 minutes'`);
    expect((await view(other)).canHost).toBe(true);
    // Vuelve (su pantalla manda el latido): reparte él de nuevo.
    await host.ok('POST', '/g/table/ping');
    expect((await view(other)).canHost).toBe(false);
    await conn.pool.query(`update poker_tables set host_seen_at = now() - interval '5 minutes'`);
    v = await other.ok('POST', '/g/table/deal');
    await finish();
    // Si se levanta, también; y entonces puede cerrar cualquiera que esté sentado.
    await host.ok('POST', '/g/table/ping');
    await host.ok('POST', '/g/table/leave');
    expect((await view(other)).canHost).toBe(true);
    expect((await other.idem('/g/table/close')).table.status).toBe('waiting');
  });

  it('si la inició un administrador sin sentarse y se va, reparte cualquiera que esté sentado', async () => {
    const { a: admin, clients: [, b, c] } = await setup(1);
    for (const x of [b, c]) await x.ok('POST', '/g/table/join');
    await admin.idem('/g/table/start', {});
    expect((await view(b)).host).toBe((await admin.ok('GET', '/me')).user.name);
    expect((await b.call('POST', '/g/table/deal')).body.error).toBe('not_host');
    // El latido del administrador lo mantiene; sin latido, se habilita a los sentados.
    await admin.ok('POST', '/g/table/ping');
    expect((await view(b)).canHost).toBe(false);
    await conn.pool.query(`update poker_tables set host_seen_at = now() - interval '5 minutes'`);
    expect((await view(b)).canHost).toBe(true);
    // Un latido de otro no cuenta.
    await b.ok('POST', '/g/table/ping');
    expect((await view(c)).canHost).toBe(true);
  });

  it('flujo completo: sentarse, iniciar (lector), jugar, cerrar y sumar a los saldos', async () => {
    const { a, b, pid, byPlayer } = await setup();
    const empty = await view(a);
    expect([empty.status, empty.seats, empty.hand]).toEqual(['waiting', [], null]);

    expect((await b.call('POST', '/g/table/start', {}, 'start-key-0001')).body.error).toBe('not_seated');
    await a.ok('POST', '/g/table/join');
    expect((await b.call('POST', '/g/table/start', {}, 'start-key-0002')).body.error).toBe('not_seated');
    await b.ok('POST', '/g/table/join');
    expect((await a.ok('GET', '/g/table')).seats.map((s: { online: boolean }) => s.online)).toEqual([true, true]);

    // Inicia un miembro de solo lectura; la mesa crea la partida.
    const started = await b.idem('/g/table/start', { buyIn: 1000 });
    expect(started).toMatchObject({ status: 'playing', buyIn: 1000, myPlayerId: pid[1] });
    expect(started.hand).toMatchObject({ handNo: 1, street: 'preflop', pot: 30 });
    expect(JSON.stringify(started)).not.toContain('"deck"');
    const sess = await a.ok('GET', `/g/sessions/${started.sessionId}`);
    expect(sess.status).toBe('active');
    expect(sess.participants.map((p: { buys: unknown[] }) => p.buys.length)).toEqual([1, 1]);

    // Cartas: las mías visibles, las ajenas ocultas.
    const mine = started.hand.players.find((p: { playerId: string }) => p.playerId === pid[1]);
    const other = started.hand.players.find((p: { playerId: string }) => p.playerId === pid[0]);
    expect(mine.hole.every((c: string) => c !== '??')).toBe(true);
    expect(other.hole).toEqual(['??', '??']);

    // Turno equivocado, estado viejo y acción ilegal.
    const actor = byPlayer(started.hand.toActPlayerId);
    const waiter = actor === a ? b : a;
    expect((await waiter.call('POST', '/g/table/action', { version: started.version, action: { type: 'call' } })).body.error).toBe('illegal_action');
    expect((await actor.call('POST', '/g/table/action', { version: started.version - 1, action: { type: 'call' } })).body.error).toBe('stale_state');
    expect((await actor.call('POST', '/g/table/action', { version: started.version, action: { type: 'check' } })).body.error).toBe('illegal_action');
    expect((await actor.call('POST', '/g/table/action', { version: started.version, action: { type: 'raise', to: 21 } })).body.error).toBe('illegal_action');
    expect((await actor.call('POST', '/g/table/deal')).body.error).toBe('hand_in_progress');
    expect((await actor.call('POST', '/g/table/close', {}, 'close-key-0001')).body.error).toBe('hand_in_progress');

    expect(started.hand.lastAction).toBeNull();
    const done = await act(actor, started, { type: 'fold' });
    expect(done.hand.lastAction).toEqual({ playerId: started.hand.toActPlayerId, type: 'fold' });
    expect(done.hand.street).toBe('done');
    expect(done.hand.payouts).toHaveLength(1);
    expect(done.seats.map((s: { stack: number }) => s.stack).sort((x: number, y: number) => x - y)).toEqual([990, 1010]);

    const closed = await a.idem('/g/table/close');
    expect(closed.table.status).toBe('waiting');
    expect(closed.table.seats).toEqual([]);
    const debts = await a.ok('GET', `/g/sessions/${closed.sessionId}/debts`);
    expect(debts.sessionStatus).toBe('closed');
    expect(debts.balances.map((b: { result: number }) => b.result).sort((x: number, y: number) => x - y)).toEqual([-10, 10]);
    expect((await a.ok('GET', '/g/balances')).map((b: { balance: number }) => b.balance).filter((n: number) => n !== 0).sort((x: number, y: number) => x - y)).toEqual([-10, 10]);
    // Se puede jugar otra partida en la misma mesa.
    await a.ok('POST', '/g/table/join');
    await b.ok('POST', '/g/table/join');
    expect((await b.idem('/g/table/start', {})).hand.handNo).toBe(2);
  });

  it('juega manos hasta el showdown conservando las fichas', async () => {
    const { a, b, byPlayer } = await setup();
    await a.ok('POST', '/g/table/join');
    await b.ok('POST', '/g/table/join');
    let v = await a.idem('/g/table/start', {});
    for (let hand = 1; hand <= 6; hand++) {
      if (hand > 1) v = await a.ok('POST', '/g/table/deal');
      expect(v.hand.handNo).toBe(hand);
      for (let i = 0; v.hand.street !== 'done'; i++) {
        if (i > 50) throw new Error('mano infinita');
        const c = byPlayer(v.hand.toActPlayerId);
        const mine = await view(c);
        const { canCheck, callAmount } = mine.hand.legal;
        v = await act(c, mine, canCheck ? { type: 'check' } : { type: 'call' });
        expect(v.hand.lastAction).toEqual(canCheck
          ? { playerId: mine.hand.toActPlayerId, type: 'check' }
          : { playerId: mine.hand.toActPlayerId, type: 'call', amount: callAmount });
      }
      expect(v.hand.board).toHaveLength(5);
      expect(v.hand.showdown).toHaveLength(2);
      expect(v.seats.reduce((x: number, s: { stack: number }) => x + s.stack, 0)).toBe(2000);
    }
    // Cierra quien la inició, no el otro jugador.
    expect((await b.call('POST', '/g/table/close', {}, 'close-showdown-1')).body.error).toBe('not_host');
    const closed = await a.idem('/g/table/close');
    const sess = await a.ok('GET', `/g/sessions/${closed.sessionId}`);
    expect(sess.status).toBe('closed');
  });

  it('cada asiento informa sus recompras y su neto en la partida', async () => {
    const { a, b, pid, byPlayer } = await setup();
    await a.ok('POST', '/g/table/join');
    await b.ok('POST', '/g/table/join');
    // Sin partida no hay compras que contar.
    expect((await view(a)).seats.map((x: { bought: number; net: number }) => [x.bought, x.net])).toEqual([[0, 0], [0, 0]]);

    let v = await a.idem('/g/table/start', {});
    const at = (view_: { seats: { playerId: string }[] }, id: string) => view_.seats.find(x => x.playerId === id) as unknown as { rebuys: number; bought: number; net: number };
    // La entrada no es una recompra.
    expect([at(v, pid[0]), at(v, pid[1])]).toEqual([{ rebuys: 0, bought: 1000, net: 0 }, { rebuys: 0, bought: 1000, net: 0 }].map(x => expect.objectContaining(x)));

    // Se retira quien tiene el turno (ciega chica): pierde 10 y el otro gana 10; el neto se actualiza al terminar la mano.
    const loser = v.hand.toActPlayerId as string;
    const winner = loser === pid[0] ? pid[1] : pid[0];
    v = await act(byPlayer(loser), v, { type: 'fold' });
    expect(at(v, loser).net).toBe(-10);
    expect(at(v, winner).net).toBe(10);

    // Recompra: suma una recompra y lo comprado; el neto sigue siendo fichas menos compradas.
    await conn.pool.query('update poker_seats set stack = 0 where player_id = $1', [loser]);
    const rebuy = await byPlayer(loser).idem('/g/table/rebuy', { amount: 200 });
    expect(at(rebuy, loser)).toMatchObject({ rebuys: 1, bought: 1200, net: 200 - 1200 });
    expect(at(rebuy, winner)).toMatchObject({ rebuys: 0, bought: 1000, net: 10 });
  });

  it('informa la última jugada, con el monto de subidas y all-in', async () => {
    const { a, b, byPlayer } = await setup();
    await a.ok('POST', '/g/table/join');
    await b.ok('POST', '/g/table/join');
    let v = await a.idem('/g/table/start', {});
    const first = byPlayer(v.hand.toActPlayerId);
    v = await act(first, v, { type: 'raise', to: 60 });
    expect(v.hand.lastAction).toEqual({ playerId: v.hand.players.find((p: { bet: number }) => p.bet === 60).playerId, type: 'raise', amount: 60 });
    // Lo ve también el otro jugador.
    const other = first === a ? b : a;
    expect((await view(other)).hand.lastAction).toMatchObject({ type: 'raise', amount: 60 });
    v = await act(other, v, { type: 'allin' });
    expect(v.hand.lastAction).toEqual({ playerId: expect.any(String), type: 'allin', amount: 1000 });
    v = await act(first, v, { type: 'call' });
    expect(v.hand.street).toBe('done');
    expect(v.hand.lastAction).toMatchObject({ type: 'call', amount: 940 });
  });

  it('valida requisitos para iniciar', async () => {
    const { a, b } = await setup();
    const noNick = await login('sin-nick');
    expect((await noNick.call('GET', '/g/table')).status).toBe(403);
    await a.ok('POST', '/g/table/join');
    expect((await a.call('POST', '/g/table/start', {}, 'start-key-0003')).body.error).toBe('not_enough_players');
    await b.ok('POST', '/g/table/join');
    // Un asiento sin presencia reciente no cuenta.
    await conn.pool.query(`update poker_seats set last_seen_at = now() - interval '5 minutes' where user_id = (select id from users where google_sub = 'lector')`);
    expect((await a.call('POST', '/g/table/start', {}, 'start-key-0004')).body.error).toBe('not_enough_players');
    await b.ok('POST', '/g/table/join');
    expect((await a.call('POST', '/g/table/start', { smallBlind: 50, bigBlind: 20 }, 'start-key-0005')).body.error).toBe('invalid_blinds');
    expect((await a.call('POST', '/g/table/start', { buyIn: 30 }, 'start-key-0006')).body.error).toBe('invalid_buy_in');
    expect((await a.call('POST', '/g/table/start', { buyIn: 0 }, 'start-key-0007')).status).toBe(400);
    await conn.pool.query(`update seasons set status = 'closed', closed_at = now()`);
    expect((await a.call('POST', '/g/table/start', {}, 'start-key-0008')).body.error).toBe('no_active_season');
  });

  it('sin nick no se puede jugar; la clave de idempotencia evita iniciar dos veces', async () => {
    const { c: a, group } = await withGroup('master');
    const l = await login('lector');
    await l.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
    l.groupId = group.id;
    expect((await l.call('POST', '/g/table/join')).body.error).toBe('no_player');
    await a.ok('POST', '/g/me/player', { name: 'Ana' });
    await l.ok('POST', '/g/me/player', { name: 'Lector' });
    await a.ok('POST', '/g/table/join');
    await l.ok('POST', '/g/table/join');
    const first = await a.ok('POST', '/g/table/start', {}, 'misma-clave-1');
    const again = await a.ok('POST', '/g/table/start', {}, 'misma-clave-1');
    expect(again.sessionId).toBe(first.sessionId);
    expect((await a.call('POST', '/g/table/start', {}, 'otra-clave-22')).body.error).toBe('already_playing');
    expect((await conn.pool.query('select count(*)::int as n from sessions')).rows[0].n).toBe(1);
  });

  it('al terminar la mano se muestran las cartas, una sola si quedó un único jugador', async () => {
    const { a, b, byPlayer } = await setup();
    await a.ok('POST', '/g/table/join');
    await b.ok('POST', '/g/table/join');
    let v = await a.idem('/g/table/start', {});
    // En medio de la mano no se muestra nada.
    expect((await a.call('POST', '/g/table/reveal', {})).body.error).toBe('hand_in_progress');
    const folder = byPlayer(v.hand.toActPlayerId);
    const winner = folder === a ? b : a;
    v = await act(folder, await view(folder), { type: 'fold' });
    expect(v.hand.street).toBe('done');
    expect(v.hand.showdown).toHaveLength(0);

    // Quien se retiró no puede mostrar una sola carta, pero sí las dos.
    expect((await folder.call('POST', '/g/table/reveal', { cards: [0] })).body.error).toBe('illegal_reveal');
    const before = (await view(folder)).hand.players.find((p: { hole: string[] }) => p.hole.every(c => c === '??'));
    expect(before.shown).toEqual([]);

    // El único que queda muestra una carta: el rival ve solo esa.
    const own = (await view(winner)).hand.players.find((p: { hole: string[] }) => !p.hole.includes('??'));
    await winner.ok('POST', '/g/table/reveal', { cards: [1] });
    const seen = (await view(folder)).hand.players.find((p: { playerId: string }) => p.playerId === own.playerId);
    expect(seen.shown).toEqual([1]);
    expect(seen.hole).toEqual(['??', own.hole[1]]);
    // Después muestra la otra, y quien se retiró muestra las suyas.
    await winner.ok('POST', '/g/table/reveal', {});
    await folder.ok('POST', '/g/table/reveal', {});
    const all = (await view(winner)).hand.players;
    expect(all.every((p: { shown: number[]; hole: string[] }) => p.shown.length === 2 && !p.hole.includes('??'))).toBe(true);

    // Con la mano siguiente en juego, la anterior ya no se muestra.
    await a.ok('POST', '/g/table/deal');
    expect((await winner.call('POST', '/g/table/reveal', {})).body.error).toBe('hand_in_progress');
  });

  it('suma jugadores con la partida en curso, recompra y se levanta', async () => {
    const { a, b, clients, pid, byPlayer } = await setup(1);
    const c = clients[2];
    await a.ok('POST', '/g/table/join');
    await b.ok('POST', '/g/table/join');
    let v = await a.idem('/g/table/start', {});
    expect(v.seats).toHaveLength(2);

    // Se suma una vez iniciada: entra con la entrada y juega desde la próxima mano.
    const late = await c.ok('POST', '/g/table/join');
    expect(late.seats).toHaveLength(3);
    expect(late.hand.players).toHaveLength(2);
    expect((await c.call('POST', '/g/table/rebuy', {}, 'rebuy-key-0001')).body.error).toBe('has_chips');
    const sess = await a.ok('GET', `/g/sessions/${v.sessionId}`);
    expect(sess.participants).toHaveLength(3);

    // El que foldea puede levantarse; sus fichas siguen en la mesa.
    const actor = byPlayer(v.hand.toActPlayerId);
    v = await act(actor, v, { type: 'fold' });
    const left = await actor.ok('POST', '/g/table/leave');
    expect(left.seats.find((s: { isYou: boolean }) => s.isYou)).toMatchObject({ status: 'out' });

    // Sin fichas, recompra (suma una compra a la partida).
    await conn.pool.query(`update poker_seats set stack = 0 where player_id = $1`, [pid[2]]);
    // Tope: la mitad de quien más tiene en la mesa (1010 con lo apostado en la mano).
    expect(v.maxRebuy).toBe(505);
    expect((await c.call('POST', '/g/table/rebuy', { amount: 506 }, 'rebuy-key-0002')).body.error).toBe('rebuy_too_high');
    const rebuy = await c.idem('/g/table/rebuy', { amount: 300 });
    expect(rebuy.seats.find((s: { playerId: string }) => s.playerId === pid[2]).stack).toBe(300);
    const after = await a.ok('GET', `/g/sessions/${v.sessionId}`);
    expect(after.participants.find((p: { playerId: string }) => p.playerId === pid[2]).buys).toHaveLength(2);

    // Siguiente mano: juegan los que están sentados con fichas.
    const next = await (actor === a ? b : a).ok('POST', '/g/table/deal');
    expect(next.hand.players.length).toBe(2);
  });

  describe('administración manual de la mesa', () => {
    /** Admin sin jugador propio y un grupo con jugadores cargados a mano (sin usuario). */
    async function adminTable(ghosts = 2) {
      const { c: admin, group } = await withGroup('master');
      const players: { id: string; name: string }[] = [];
      for (let i = 0; i < ghosts; i++) players.push(await admin.ok('POST', '/g/players', { name: `Fantasma${i}` }));
      const reader = await login('lector');
      await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
      reader.groupId = group.id;
      return { admin, reader, players };
    }

    it('quien se retiró de la mano en juego sin fichas puede recomprar', async () => {
      const { admin, players } = await adminTable(3);
      for (const p of players) await admin.ok('POST', `/g/table/seats/${p.id}`);
      let v = await admin.idem('/g/table/start', {});
      expect(v.hand.players).toHaveLength(3);
      const folder = v.hand.toActPlayerId;
      v = await admin.ok('POST', '/g/table/action', { version: v.version, playerId: folder, action: { type: 'fold' } });
      expect(v.hand.street).not.toBe('done');
      // Sigue la mano de los otros dos; el que se retiró se quedó sin saldo.
      const idx = v.hand.players.findIndex((p: { playerId: string }) => p.playerId === folder);
      await conn.pool.query(`update poker_hands set state = jsonb_set(state, '{players,${idx},stack}', '0') where status = 'active'`);
      const rebuy = await admin.ok('POST', `/g/table/seats/${folder}/rebuy`, { amount: 200 }, 'folded-rebuy-1');
      expect(rebuy.seats.find((s: { playerId: string }) => s.playerId === folder).stack).toBe(200);
      // Al terminar la mano las fichas recompradas siguen ahí.
      const next = rebuy.hand.toActPlayerId;
      v = await admin.ok('POST', '/g/table/action', { version: rebuy.version, playerId: next, action: { type: 'fold' } });
      expect(v.hand.street).toBe('done');
      expect(v.seats.find((s: { playerId: string }) => s.playerId === folder).stack).toBe(200);
    });

    it('un administrador sienta jugadores sin usuario, que cuentan como presentes', async () => {
      const { admin, reader, players } = await adminTable();
      const v = await admin.ok('POST', `/g/table/seats/${players[0].id}`);
      expect(v.seats).toEqual([expect.objectContaining({ playerId: players[0].id, online: true, managed: true, isYou: false })]);
      expect((await admin.ok('POST', `/g/table/seats/${players[0].id}`)).seats).toHaveLength(1); // repetir no duplica
      // Pasan los 45 s de presencia: sigue presente porque lo sentó un administrador.
      await conn.pool.query(`update poker_seats set last_seen_at = now() - interval '5 minutes'`);
      expect((await admin.ok('GET', '/g/table')).seats[0].online).toBe(true);
      // Solo lectura no puede; jugador archivado o inexistente, tampoco.
      expect((await reader.call('POST', `/g/table/seats/${players[0].id}`)).body.error).toBe('read_only');
      expect((await reader.call('DELETE', `/g/table/seats/${players[0].id}`)).body.error).toBe('read_only');
      expect((await admin.call('POST', '/g/table/seats/no-existe')).status).toBe(404);
      await admin.ok('POST', `/g/players/${players[1].id}/adjustments`, { description: 'x', amount: 1 });
      await admin.ok('DELETE', `/g/players/${players[1].id}`);
      expect((await admin.call('POST', `/g/table/seats/${players[1].id}`)).body.error).toBe('player_archived');
      // Se puede quitar mientras se espera.
      expect((await admin.ok('DELETE', `/g/table/seats/${players[0].id}`)).seats).toEqual([]);
    });

    it('el administrador inicia, ve las cartas de quienes maneja y juega sus turnos', async () => {
      const { admin, reader, players } = await adminTable();
      await admin.ok('POST', `/g/table/seats/${players[0].id}`);
      await admin.ok('POST', `/g/table/seats/${players[1].id}`);
      expect((await reader.call('POST', '/g/table/start', {}, 'manual-start-1')).body.error).toBe('no_player');
      // Sin estar sentado ni tener jugador, inicia.
      let v = await admin.idem('/g/table/start', {});
      expect(v.hand.players).toHaveLength(2);
      expect(v.myPlayerId).toBeNull();
      expect(v.hand.players.every((p: { hole: string[] }) => p.hole.every(c => c !== '??'))).toBe(true);
      expect(v.hand.actingPlayerId).toBe(v.hand.toActPlayerId);
      expect(v.hand.legal).not.toBeNull();

      // Juega por el jugador al que le toca, sin indicar quién: se rechaza (no tiene jugador propio).
      expect((await admin.call('POST', '/g/table/action', { version: v.version, action: { type: 'call' } })).body.error).toBe('no_player');
      const first = v.hand.toActPlayerId;
      v = await admin.ok('POST', '/g/table/action', { version: v.version, playerId: first, action: { type: 'call' } });
      expect(v.hand.lastAction).toMatchObject({ playerId: first, type: 'call' });
      // Termina la mano pasando por los dos.
      for (let i = 0; v.hand.street !== 'done'; i++) {
        if (i > 40) throw new Error('mano infinita');
        const who = v.hand.toActPlayerId;
        v = await admin.ok('POST', '/g/table/action', {
          version: v.version, playerId: who, action: v.hand.legal.canCheck ? { type: 'check' } : { type: 'call' },
        });
      }
      expect(v.hand.showdown).toHaveLength(2);
      // Cada ganador viene con el porqué (la jugada y, si hizo falta, la carta que desempata).
      for (const w of v.hand.payouts) {
        expect(w.reason).toMatch(/^(Carta alta|Par|Doble par|Trío|Escalera|Color|Full house|Póker)/);
        // Y las 5 cartas de su jugada, todas visibles: de la mesa o de su mano (que gana y se muestra).
        const winner = v.hand.players.find((p: { playerId: string }) => p.playerId === w.playerId);
        expect(w.cards).toHaveLength(5);
        for (const c of w.cards) expect([...v.hand.board, ...winner.hole]).toContain(c);
      }
      // El administrador reparte y cierra sin estar sentado.
      v = await admin.ok('POST', '/g/table/deal');
      expect(v.hand.handNo).toBe(2);
      v = await admin.ok('POST', '/g/table/action', { version: v.version, playerId: v.hand.toActPlayerId, action: { type: 'fold' } });
      const closed = await admin.idem('/g/table/close');
      expect(closed.table.status).toBe('waiting');
    });

    it('solo se juega por jugadores sin usuario, y solo un administrador puede', async () => {
      const { admin, reader, players } = await adminTable(1);
      const mine = await reader.ok('POST', '/g/me/player', { name: 'Lector' });
      await admin.ok('POST', `/g/table/seats/${players[0].id}`);
      await reader.ok('POST', '/g/table/join');
      let v = await admin.idem('/g/table/start', {});
      const ghost = players[0].id;
      const readerView = await view(reader);
      // El lector no ve las cartas del fantasma, ni puede jugar por él.
      expect(readerView.hand.players.find((p: { playerId: string }) => p.playerId === ghost).hole).toEqual(['??', '??']);
      expect((await reader.call('POST', '/g/table/action', { version: v.version, playerId: ghost, action: { type: 'fold' } })).body.error).toBe('read_only');
      // El administrador ve las del fantasma pero no las del lector, y no puede jugar por él.
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === mine.id).hole).toEqual(['??', '??']);
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === ghost).hole[0]).not.toBe('??');
      expect((await admin.call('POST', '/g/table/action', { version: v.version, playerId: mine.id, action: { type: 'fold' } })).body.error).toBe('not_managed');
      // Si le toca al lector, el administrador no recibe acciones para jugar.
      if (v.hand.toActPlayerId === mine.id) {
        expect(v.hand.legal).toBeNull();
        v = await act(reader, v, { type: 'call' });
      }
      expect(v.hand.toActPlayerId).toBe(ghost);
      expect(v.hand.actingPlayerId).toBe(ghost);
    });

    it('si un jugador sentado se vincula a un usuario, juega él; si se desvincula, vuelve a manejarlo el administrador', async () => {
      const { admin, reader, players } = await adminTable();
      const [ghost, other] = players;
      await admin.ok('POST', `/g/table/seats/${ghost.id}`);
      await admin.ok('POST', `/g/table/seats/${other.id}`);
      let v = await admin.idem('/g/table/start', {});
      const before = v.version;
      // Con la mano en juego, el lector elige al jugador sentado como su nick.
      await reader.ok('POST', '/g/me/player', { playerId: ghost.id });
      v = await view(admin);
      expect(v.version).toBeGreaterThan(before);
      expect(v.seats.find((s: { playerId: string }) => s.playerId === ghost.id).managed).toBe(false);
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === ghost.id).hole).toEqual(['??', '??']);
      expect((await admin.call('POST', '/g/table/action', { version: v.version, playerId: ghost.id, action: { type: 'fold' } })).body.error).toBe('not_managed');
      const readerView = await view(reader);
      expect(readerView.myPlayerId).toBe(ghost.id);
      expect(readerView.hand.players.find((p: { playerId: string }) => p.playerId === ghost.id).hole[0]).not.toBe('??');
      // El administrador lo desvincula: vuelve a manejarlo.
      await admin.ok('POST', `/g/players/${ghost.id}/user`, { userId: null });
      v = await view(admin);
      expect(v.seats.find((s: { playerId: string }) => s.playerId === ghost.id).managed).toBe(true);
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === ghost.id).hole[0]).not.toBe('??');
    });

    it('suma, recompra y levanta con la partida en curso', async () => {
      const { admin, players } = await adminTable(3);
      await admin.ok('POST', `/g/table/seats/${players[0].id}`);
      await admin.ok('POST', `/g/table/seats/${players[1].id}`);
      let v = await admin.idem('/g/table/start', {});
      // Se suma otro: entra con la compra de entrada y juega desde la próxima mano.
      v = await admin.ok('POST', `/g/table/seats/${players[2].id}`);
      expect(v.seats.find((s: { playerId: string }) => s.playerId === players[2].id).stack).toBe(1000);
      expect(v.hand.players).toHaveLength(2);
      const sess = await admin.ok('GET', `/g/sessions/${v.sessionId}`);
      expect(sess.participants).toHaveLength(3);
      // En medio de la mano no se puede levantar a quien sigue jugando.
      const inHand = v.hand.toActPlayerId;
      expect((await admin.call('DELETE', `/g/table/seats/${inHand}`)).body.error).toBe('in_hand');
      expect((await admin.call('POST', `/g/table/seats/${inHand}/rebuy`, {}, 'manual-rebuy-1')).body.error).toBe('in_hand');
      v = await admin.ok('POST', '/g/table/action', { version: v.version, playerId: inHand, action: { type: 'fold' } });
      // Sin fichas, el administrador recompra por él.
      await conn.pool.query(`update poker_seats set stack = 0 where player_id = $1`, [players[2].id]);
      const rebuy = await admin.ok('POST', `/g/table/seats/${players[2].id}/rebuy`, {}, 'manual-rebuy-2');
      // Sin monto, la entrada o el tope si es menor.
      expect(rebuy.seats.find((s: { playerId: string }) => s.playerId === players[2].id).stack).toBe(Math.min(1000, rebuy.maxRebuy));
      // Terminada la mano, se lo levanta; sus fichas siguen en la mesa.
      const out = await admin.ok('DELETE', `/g/table/seats/${players[2].id}`);
      expect(out.seats.find((s: { playerId: string }) => s.playerId === players[2].id).status).toBe('out');
    });
  });

  describe('sin fichas: cartas ocultas hasta recomprar', () => {
    const expire = () => conn.pool.query(`update poker_tables set turn_deadline = now() - interval '1 second'`);
    const seatOf = async (playerId: string) => (await conn.pool.query('select status, timeouts, stack from poker_seats where player_id = $1', [playerId])).rows[0];

    /** Tres jugadores en la mesa; el tercero se queda sin fichas y se reparte la mano siguiente. */
    async function withBrokePlayer(startBody: object = { turnSeconds: 10 }) {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', startBody);
      // Termina la primera mano (todos se retiran) y el tercero queda sin fichas.
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      await conn.pool.query('update poker_seats set stack = 0 where player_id = $1', [ctx.pid[2]]);
      v = await a.ok('POST', '/g/table/deal');
      return { ...ctx, a, b, c, v, broke: ctx.pid[2] };
    }
    /** Hasta que le toque al pendiente, los demás igualan o pasan. */
    async function untilTurnOf(ctx: Awaited<ReturnType<typeof withBrokePlayer>>, playerId: string) {
      let v = await view(ctx.a);
      for (let i = 0; v.hand.toActPlayerId !== playerId; i++) {
        if (i > 10 || v.hand.street === 'done') throw new Error('no le llegó el turno');
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        const cur = await view(who);
        v = await act(who, cur, cur.hand.legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      return v;
    }

    it('al sentado sin fichas se le reparte, pero no ve sus cartas ni puede jugar: solo retirarse', async () => {
      const ctx = await withBrokePlayer();
      const { c, broke, v } = ctx;
      const mine = v.hand.players.find((p: { playerId: string }) => p.playerId === broke);
      expect([mine.pending, mine.stack, mine.bet]).toEqual([true, 0, 0]);
      // Sus cartas están ocultas para todos, incluido él.
      expect((await view(c)).hand.players.find((p: { playerId: string }) => p.playerId === broke).hole).toEqual(['??', '??']);
      const turn = await untilTurnOf(ctx, broke);
      const own = await view(c);
      expect(own.hand.legal).toMatchObject({ mustBuy: true, canCheck: false, canCall: false, canRaise: false });
      for (const action of [{ type: 'check' }, { type: 'call' }, { type: 'allin' }]) {
        expect((await c.call('POST', '/g/table/action', { version: turn.version, action })).body.error).toBe('illegal_action');
      }
      const folded = await act(c, own, { type: 'fold' });
      expect(folded.hand.players.find((p: { playerId: string }) => p.playerId === broke)).toMatchObject({ folded: true, pending: true, hole: ['??', '??'] });
      expect(await seatOf(broke)).toMatchObject({ status: 'sitting', timeouts: 0 });
    });

    it('si recompra a tiempo ve sus cartas, juega con esas fichas y la compra suma a la partida', async () => {
      const ctx = await withBrokePlayer();
      const { a, c, broke } = ctx;
      await untilTurnOf(ctx, broke);
      const bought = await c.idem('/g/table/rebuy', { amount: 200 });
      const mine = bought.hand.players.find((p: { playerId: string }) => p.playerId === broke);
      expect(mine).toMatchObject({ pending: false, stack: 200 });
      expect(mine.hole.every((x: string) => x !== '??')).toBe(true);
      expect(bought.hand.toActPlayerId).toBe(broke);
      expect(bought.hand.legal).toMatchObject({ mustBuy: false, canCall: true });
      const sess = await a.ok('GET', `/g/sessions/${bought.sessionId}`);
      expect(sess.participants.find((p: { playerId: string }) => p.playerId === broke).buys.map((x: { amount: number }) => x.amount)).toEqual([1000, 200]);
      // Ya con fichas, actúa frente a la apuesta vigente.
      const after = await act(c, bought, { type: 'call' });
      expect(after.hand.lastAction).toMatchObject({ playerId: broke, type: 'call' });
      // El tope de la recompra sigue vigente.
      const again = await withBrokePlayer();
      await untilTurnOf(again, again.broke);
      expect((await again.c.call('POST', '/g/table/rebuy', { amount: 10_000 }, 'rebuy-tope-001')).body.error).toBe('rebuy_too_high');
    });

    it('si no recompra a tiempo, el servidor lo retira y nunca lo saca de la mesa', async () => {
      const ctx = await withBrokePlayer();
      const { a, broke } = ctx;
      await untilTurnOf(ctx, broke);
      await expire();
      expect(await sweepTurns(app)).toEqual([a.groupId]);
      const v = await view(a);
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === broke)).toMatchObject({ folded: true, pending: true });
      expect(v.hand.lastAction).toEqual({ playerId: broke, type: 'fold', auto: true });
      expect(await seatOf(broke)).toMatchObject({ status: 'sitting', timeouts: 0 });
      // Termina la mano y en la siguiente le reparten otra vez, y otra vez se retira: sigue sentado.
      let cur = v;
      while (cur.hand.street !== 'done') {
        const who = ctx.byPlayer(cur.hand.toActPlayerId);
        cur = await act(who, await view(who), { type: 'fold' });
      }
      await a.ok('POST', '/g/table/deal');
      await untilTurnOf(ctx, broke);
      await expire();
      await sweepTurns(app);
      expect(await seatOf(broke)).toMatchObject({ status: 'sitting', timeouts: 0 });
    });

    it('si se desconecta antes de su turno, se retira en cuanto le toca, sin esperar', async () => {
      const ctx = await withBrokePlayer();
      const { a, broke } = ctx;
      await conn.pool.query(`update poker_seats set last_seen_at = now() - interval '5 minutes' where player_id = $1`, [broke]);
      await untilTurnOf(ctx, broke);
      // El vencimiento ya está cumplido: no hace falta adelantar el reloj.
      expect((await view(a)).turnDeadline && new Date((await view(a)).turnDeadline).getTime() <= Date.now() + 1000).toBe(true);
      expect(await sweepTurns(app)).toEqual([a.groupId]);
      expect((await view(a)).hand.lastAction).toEqual({ playerId: broke, type: 'fold', auto: true });
    });

    it('un sentado sin fichas que ya no está conectado no se reparte, y sigue en la mesa', async () => {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', { turnSeconds: 10 });
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      await conn.pool.query(`update poker_seats set stack = 0, last_seen_at = now() - interval '5 minutes' where player_id = $1`, [ctx.pid[2]]);
      v = await a.ok('POST', '/g/table/deal');
      expect(v.hand.players.map((p: { playerId: string }) => p.playerId)).not.toContain(ctx.pid[2]);
      expect(await seatOf(ctx.pid[2])).toMatchObject({ status: 'sitting' });
    });

    it('sin límite de turno, quien debe recomprar igual tiene un tiempo (los demás no)', async () => {
      const ctx = await withBrokePlayer({ turnSeconds: 0 });
      const { a, broke } = ctx;
      let v = await view(a);
      if (v.hand.toActPlayerId !== broke) expect(v.turnDeadline).toBeNull();
      v = await untilTurnOf(ctx, broke);
      const left = new Date(v.turnDeadline).getTime() - new Date(v.serverTime).getTime();
      expect(left).toBeGreaterThan(40_000);
      expect(left).toBeLessThanOrEqual(45_000);
      await expire();
      expect(await sweepTurns(app)).toEqual([a.groupId]);
    });
  });

  describe('historial de manos', () => {
    const rows = async (sql: string, params: unknown[] = []) => (await conn.pool.query(sql, params)).rows;

    /** Juega una mano entre tres: el primero sube, los demás igualan y se llega al showdown. */
    async function playedHand() {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', {});
      const first = ctx.byPlayer(v.hand.toActPlayerId);
      v = await act(first, v, { type: 'raise', to: 60 });
      for (let i = 0; v.hand.street !== 'done'; i++) {
        if (i > 30) throw new Error('mano infinita');
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        const cur = await view(who);
        v = await act(who, cur, cur.hand.legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      return { ...ctx, v };
    }

    it('cada mano queda con su partida, ciegas, pozo, board y cómo terminó', async () => {
      const { v } = await playedHand();
      const [hand] = await rows('select * from poker_hands');
      expect(hand).toMatchObject({
        status: 'done', session_id: v.sessionId, small_blind: 10, big_blind: 20, pot: 180, ended_on: 'river', went_to_showdown: true,
      });
      expect(hand.board).toHaveLength(5);
      // El mazo no se guarda; las cartas de la mano sí (solo del servidor).
      expect(hand.state.deck).toEqual([]);
    });

    it('guarda una fila por jugador: posición, fichas y cartas con que empezó, y su resultado', async () => {
      const { pid } = await playedHand();
      const [hand] = await rows('select * from poker_hands');
      const players = await rows('select * from poker_hand_players order by seat_order');
      expect(players).toHaveLength(3);
      expect(players.map(p => p.position).sort()).toEqual(['BB', 'BTN', 'SB']);
      expect(players.map(p => p.position_index).sort()).toEqual([0, 1, 2]);
      for (const p of players) {
        expect([p.start_stack, p.pending, p.bought_in_hand, p.has_street_data]).toEqual([1000, false, 0, true]);
        // Las cartas guardadas son las de la mano.
        expect(p.hole).toEqual(hand.state.players.find((x: { id: string }) => x.id === p.player_id).hole);
        expect(p.hole).toHaveLength(2);
        expect([p.invested, p.showdown]).toEqual([60, true]);
        expect(Object.values(pid)).toContain(p.player_id);
      }
      // El pozo se reparte tal cual: lo ganado menos lo aportado suma cero.
      expect(players.reduce((x, p) => x + p.invested, 0)).toBe(hand.pot);
      expect(players.reduce((x, p) => x + p.won, 0)).toBe(hand.pot);
      expect(players.reduce((x, p) => x + p.net, 0)).toBe(0);
      expect(players.filter(p => p.won_showdown).length).toBeGreaterThanOrEqual(1);
      // Todos entraron voluntariamente al pozo antes del flop (uno subió, los demás igualaron); el que subió es el único con pfr.
      expect(players.every(p => p.vpip && p.saw_flop)).toBe(true);
      expect(players.filter(p => p.pfr)).toHaveLength(1);
      expect(players.find(p => p.pfr)).toMatchObject({ raises: 1 });
    });

    it('cada jugada guarda la situación en que se jugó', async () => {
      await playedHand();
      const actions = await rows('select * from poker_actions order by seq');
      expect(actions.length).toBeGreaterThan(3);
      for (const a of actions) {
        expect(['preflop', 'flop', 'turn', 'river']).toContain(a.street);
        expect(['fold', 'check', 'call', 'raise']).toContain(a.kind);
        expect(a.pot_before).toBeGreaterThanOrEqual(30);
        expect(a.stack_before).toBeGreaterThanOrEqual(0);
        expect(a.players_left).toBe(3);
        expect(a.auto).toBe(false);
      }
      // La primera: el que habla primero antes del flop sube a 60 frente a la ciega grande, con el pozo de las ciegas.
      expect(actions[0]).toMatchObject({ street: 'preflop', kind: 'raise', amount: 60, pot_before: 30, to_call: 20, stack_before: 1000 });
      expect(actions.slice(1, 3).map(a => [a.kind, a.amount])).toEqual([['call', 50], ['call', 40]]);
      expect(actions.filter(a => a.street === 'flop').map(a => a.kind)).toEqual(['check', 'check', 'check']);
    });

    it('un jugador pendiente que recompra a mitad de la mano queda registrado', async () => {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', { turnSeconds: 10 });
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      await conn.pool.query('update poker_seats set stack = 0 where player_id = $1', [ctx.pid[2]]);
      v = await a.ok('POST', '/g/table/deal');
      // Hasta que le toca al pendiente.
      for (let i = 0; v.hand.toActPlayerId !== ctx.pid[2]; i++) {
        if (i > 10) throw new Error('no le llegó el turno');
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        const cur = await view(who);
        v = await act(who, cur, cur.hand.legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      await c.idem('/g/table/rebuy', { amount: 200 });
      const [row] = await rows('select hp.* from poker_hand_players hp join poker_hands h on h.id = hp.hand_id where h.hand_no = 2 and hp.player_id = $1', [ctx.pid[2]]);
      expect(row).toMatchObject({ pending: true, start_stack: 0, bought_in_hand: 200, position: null });
      // Termina la mano y se completa su resultado.
      v = await view(c);
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      const [done] = await rows('select hp.* from poker_hand_players hp join poker_hands h on h.id = hp.hand_id where h.hand_no = 2 and hp.player_id = $1', [ctx.pid[2]]);
      expect(done).toMatchObject({ bought_in_hand: 200, has_street_data: true });
      expect((await rows('select sum(net)::int as n from poker_hand_players hp join poker_hands h on h.id = hp.hand_id where h.hand_no = 2'))[0].n).toBe(0);
    });

    it('el pendiente que se retira por tiempo agotado queda con jugada automática y sin ver el flop', async () => {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', { turnSeconds: 10 });
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      await conn.pool.query('update poker_seats set stack = 0 where player_id = $1', [ctx.pid[2]]);
      v = await a.ok('POST', '/g/table/deal');
      for (let i = 0; v.hand.toActPlayerId !== ctx.pid[2]; i++) {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        const cur = await view(who);
        v = await act(who, cur, cur.hand.legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      await conn.pool.query(`update poker_tables set turn_deadline = now() - interval '1 second'`);
      await sweepTurns(app);
      // Se retiró solo el pendiente: la mano sigue entre los otros dos hasta que termina.
      v = await view(a);
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      const [row] = await rows('select hp.* from poker_hand_players hp join poker_hands h on h.id = hp.hand_id where h.hand_no = 2 and hp.player_id = $1', [ctx.pid[2]]);
      expect(row).toMatchObject({ pending: true, folded_street: 'preflop', auto_actions: 1, folds: 1, saw_flop: false, vpip: false, invested: 0, won: 0, net: 0 });
    });

    it('reconstruye las manos viejas con lo que tienen: resultado y cartas, sin el detalle por calle', async () => {
      await playedHand();
      const [before] = await rows('select * from poker_hand_players order by seat_order limit 1');
      // Se simula una mano guardada antes de que existiera el historial.
      await conn.pool.query('delete from poker_hand_players');
      await conn.pool.query('update poker_hands set session_id = null, small_blind = null, big_blind = null, pot = null, board = null, ended_on = null, went_to_showdown = null');
      expect(await backfillHandHistory(conn.db)).toBe(1);
      const players = await rows('select * from poker_hand_players order by seat_order');
      expect(players).toHaveLength(3);
      for (const p of players) {
        expect(p).toMatchObject({ has_street_data: false, vpip: null, pfr: null, saw_flop: null, raises: null, folded_street: null, invested: 60 });
        expect(p.hole).toHaveLength(2);
      }
      expect(players.reduce((x, p) => x + p.net, 0)).toBe(0);
      expect(players.map(p => p.position).sort()).toEqual(['BB', 'BTN', 'SB']);
      expect(players.find(p => p.player_id === before.player_id)!.hole).toEqual(before.hole);
      const [hand] = await rows('select * from poker_hands');
      expect(hand).toMatchObject({ small_blind: 10, big_blind: 20, pot: 180, ended_on: 'river', went_to_showdown: true });
      // Idempotente: una segunda vez no hay nada que completar.
      expect(await backfillHandHistory(conn.db)).toBe(0);
    });
  });

  describe('análisis de la partida', () => {
    const rows = async (sql: string, params: unknown[] = []) => (await conn.pool.query(sql, params)).rows;

    /** Los tres van all-in preflop: el dinero queda adentro con el board por salir. */
    async function allInHand() {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', { turnSeconds: 30 });
      for (let i = 0; v.hand.street !== 'done'; i++) {
        if (i > 10) throw new Error('mano infinita');
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'allin' });
      }
      return { ...ctx, v, a };
    }

    it('guarda el board completo, la clase de las cartas, el all-in y el tiempo de decisión', async () => {
      await allInHand();
      const [hand] = await rows('select * from poker_hands');
      expect(hand.full_board).toHaveLength(5);
      expect(hand.full_board.slice(0, hand.board.length)).toEqual(hand.board);
      const players = await rows('select * from poker_hand_players');
      for (const p of players) {
        expect(p.hand_class).toMatch(/^[2-9TJQKA]{2}[so]?$/);
        // 0 es válido: la peor mano inicial (7-2 sin color) tiene fuerza 0.
        expect(p.card_score).toBeGreaterThanOrEqual(0);
        expect(p.card_score).toBeLessThanOrEqual(1);
        expect(p.all_in_equity).not.toBeNull();
      }
      expect(players.reduce((x, p) => x + p.all_in_equity, 0)).toBeCloseTo(1, 5);
      expect(Math.abs(players.reduce((x, p) => x + p.ev_net, 0))).toBeLessThan(0.5);
      const actions = await rows('select * from poker_actions order by seq');
      expect(actions.some(a => a.all_in)).toBe(true);
      for (const a of actions) expect(a.think_ms).toBeGreaterThanOrEqual(0);
    });

    it('se bloquea mientras la partida está en juego y se abre al cerrarla', async () => {
      const { v, a } = await allInHand();
      const locked = await a.call('GET', `/g/sessions/${v.sessionId}/analysis`);
      expect([locked.status, locked.body.error]).toEqual([409, 'analysis_locked']);
      await a.idem('/g/table/close');
      const out = await a.ok('GET', `/g/sessions/${v.sessionId}/analysis`);
      expect(out).toMatchObject({ hands: 1, handsWithRunout: 1 });
      expect(out.players).toHaveLength(3);
      expect(out.players.reduce((x: number, p: { net: number }) => x + p.net, 0)).toBe(0);
      expect(out.handRows[0].players.every((p: { hole: string[] }) => p.hole.length === 2)).toBe(true);
      expect(Object.keys(out.names)).toHaveLength(3);
      expect(out.whatIf.allIns).toHaveLength(3);
      expect(out.series.endedOn.river).toBe(1);
    });

    it('no muestra la partida de otro grupo', async () => {
      const { v } = await allInHand();
      const { c: stranger, group } = await withGroup('intruso');
      const res = await stranger.call('GET', `/groups/${group.id}/sessions/${v.sessionId}/analysis`);
      expect(res.status).toBe(404);
    });

    it('completa el análisis de manos que ya estaban en el historial, una sola vez', async () => {
      await allInHand();
      const [before] = await rows('select hand_class, card_score, all_in_equity, ev_net from poker_hand_players order by seat_order limit 1');
      await conn.pool.query('update poker_hand_players set hand_class = null, card_score = null, all_in_equity = null, ev_net = null');
      expect(await backfillHandInsights(conn.db)).toBe(1);
      const [after] = await rows('select hand_class, card_score, all_in_equity, ev_net from poker_hand_players order by seat_order limit 1');
      expect(after.hand_class).toBe(before.hand_class);
      expect(after.card_score).toBe(before.card_score);
      expect(after.all_in_equity).not.toBeNull();
      expect(await backfillHandInsights(conn.db)).toBe(0);
    });
  });

  describe('mostrar todas las cartas al terminar', () => {
    const holes = (v: { hand: { players: { hole: string[] }[] } }) => v.hand.players.map(p => p.hole);

    async function foldedHand(showAllCards: boolean) {
      const ctx = await setup(1);
      const [a, b, c] = ctx.clients;
      for (const x of [a, b, c]) await x.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', { showAllCards });
      expect(v.showAllCards).toBe(showAllCards);
      // En juego, nadie ve las cartas de los demás.
      expect(holes(await view(b)).filter(h => !h.includes('??'))).toHaveLength(1);
      while (v.hand.street !== 'done') {
        const who = ctx.byPlayer(v.hand.toActPlayerId);
        v = await act(who, await view(who), { type: 'fold' });
      }
      return { ...ctx, a, b, c };
    }

    it('con la opción, al terminar todos ven las cartas de todos, también las de quienes se retiraron', async () => {
      const { a, b, c } = await foldedHand(true);
      for (const x of [a, b, c]) {
        const v = await view(x);
        expect(holes(v).every(h => h.length === 2 && !h.includes('??'))).toBe(true);
        expect(v.hand.players.every((p: { shown: number[] }) => p.shown.length === 2)).toBe(true);
      }
      // La mano siguiente vuelve a ocultarlas.
      const next = await a.ok('POST', '/g/table/deal');
      expect(holes(await view(b)).filter(h => !h.includes('??'))).toHaveLength(1);
      expect(next.showAllCards).toBe(true);
    });

    it('sin la opción, quienes se retiraron siguen ocultos', async () => {
      const { b } = await foldedHand(false);
      expect(holes(await view(b)).filter(h => h.includes('??')).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('mano de la partida', () => {
    it('cuenta las manos de la partida en curso y vuelve a 1 en una partida nueva', async () => {
      const { a, b, pid } = await setup(0);
      for (const c of [a, b]) await c.ok('POST', '/g/table/join');
      const finish = async (first: Client) => {
        let v = await view(first);
        while (v.hand.street !== 'done') {
          const who = v.hand.toActPlayerId === pid[0] ? a : b;
          v = await act(who, await view(who), { type: 'fold' });
        }
      };
      let v = await a.idem('/g/table/start', {});
      expect([v.hand.handNo, v.hand.gameHandNo]).toEqual([1, 1]);
      await finish(a);
      v = await a.ok('POST', '/g/table/deal');
      expect([v.hand.handNo, v.hand.gameHandNo]).toEqual([2, 2]);
      await finish(a);
      await a.idem('/g/table/close');
      for (const c of [a, b]) await c.ok('POST', '/g/table/join');
      v = await a.idem('/g/table/start', {});
      expect([v.hand.handNo, v.hand.gameHandNo]).toEqual([3, 1]);
    });
  });

  describe('salir de una partida en curso', () => {
    const sessionCount = async () => (await conn.pool.query('select count(*)::int as n from sessions')).rows[0].n as number;

    it('se puede salir en medio de una mano: se retira solo cuando le toca y la partida sigue', async () => {
      const { a, clients, pid, byPlayer } = await setup(2); // tres jugadores reales
      for (const c of clients) await c.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', {});
      // Se va alguien a quien todavía no le tocaba.
      const leaver = clients.find(c => c !== byPlayer(v.hand.toActPlayerId) && v.hand.players.some((p: { playerId: string }) => p.playerId === pid[clients.indexOf(c)]))!;
      const leaverId = pid[clients.indexOf(leaver)];
      const out = await leaver.ok('POST', '/g/table/leave');
      expect(out.status).toBe('playing');
      expect(out.seats.find((s: { isYou: boolean }) => s.isYou)).toMatchObject({ status: 'out' });
      expect(await sessionCount()).toBe(1);
      // Sigue la mano: al llegarle el turno el servidor lo retira sin esperar.
      for (let i = 0; i < 12 && v.hand.street !== 'done'; i++) {
        if (v.hand.toActPlayerId === leaverId) {
          expect(await sweepTurns(app)).toEqual([a.groupId]);
          v = await view(a);
          expect(v.hand.players.find((p: { playerId: string }) => p.playerId === leaverId).folded).toBe(true);
          break;
        }
        const who = byPlayer(v.hand.toActPlayerId);
        const cur = await view(who);
        v = await act(who, cur, cur.hand.legal.canCheck ? { type: 'check' } : { type: 'call' });
      }
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === leaverId).folded).toBe(true);
    });

    it('si le tocaba, se retira enseguida', async () => {
      const { a, clients, byPlayer } = await setup(1);
      for (const c of clients) await c.ok('POST', '/g/table/join');
      let v = await a.idem('/g/table/start', {});
      const actor = byPlayer(v.hand.toActPlayerId);
      const actorId = v.hand.toActPlayerId;
      await actor.ok('POST', '/g/table/leave');
      expect(await sweepTurns(app)).toEqual([a.groupId]);
      v = await view(a);
      expect(v.hand.players.find((p: { playerId: string }) => p.playerId === actorId).folded).toBe(true);
    });

    it('si no queda ningún jugador real la partida se cancela y no se registra', async () => {
      const { a, b, clients, pid } = await setup(0);
      for (const c of clients) await c.ok('POST', '/g/table/join');
      const before = await a.ok('GET', '/g/balances');
      let v = await a.idem('/g/table/start', {});
      const sessionId = v.sessionId;
      expect(await sessionCount()).toBe(1);
      // Juegan una mano completa: queda en el historial mientras la partida existe.
      while (v.hand.street !== 'done') {
        const who = v.hand.toActPlayerId === pid[0] ? a : b;
        v = await act(who, await view(who), { type: 'fold' });
      }
      expect(Number((await conn.pool.query('select count(*) from poker_hands')).rows[0].count)).toBe(1);

      // El primero se va: la partida sigue con el otro.
      const first = await a.ok('POST', '/g/table/leave');
      expect(first.status).toBe('playing');
      expect(await sessionCount()).toBe(1);
      // Se va el último jugador real: se cancela.
      const last = await b.ok('POST', '/g/table/leave');
      expect(last).toMatchObject({ status: 'waiting', sessionId: null, seats: [], hand: null });
      expect(await sessionCount()).toBe(0);
      expect((await a.call('GET', `/g/sessions/${sessionId}`)).status).toBe(404);
      for (const table of ['poker_hands', 'poker_hand_players', 'poker_actions', 'session_participants', 'buys', 'balance_entries']) {
        expect([table, Number((await conn.pool.query(`select count(*) from ${table}`)).rows[0].count)]).toEqual([table, 0]);
      }
      expect(await a.ok('GET', '/g/balances')).toEqual(before);
      expect(await a.ok('GET', '/g/ranking')).toEqual([]);
      // La mesa queda lista para una partida nueva.
      v = await a.ok('POST', '/g/table/join');
      await b.ok('POST', '/g/table/join');
      v = await a.idem('/g/table/start', {});
      expect(v.status).toBe('playing');
      expect(await sessionCount()).toBe(1);
    });

    it('con jugadores sin usuario que sobran, igual se cancela al irse el último jugador real', async () => {
      const { c: admin, group } = await withGroup('master');
      const ghosts = [await admin.ok('POST', '/g/players', { name: 'Fantasma0' }), await admin.ok('POST', '/g/players', { name: 'Fantasma1' })];
      const reader = await login('lector');
      await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
      reader.groupId = group.id;
      await reader.ok('POST', '/g/me/player', { name: 'Real' });
      await reader.ok('POST', '/g/table/join');
      for (const g of ghosts) await admin.ok('POST', `/g/table/seats/${g.id}`);
      await reader.idem('/g/table/start', {});
      expect(await sessionCount()).toBe(1);
      const out = await reader.ok('POST', '/g/table/leave');
      expect(out).toMatchObject({ status: 'waiting', sessionId: null });
      expect(await sessionCount()).toBe(0);
    });

    it('una partida de solo jugadores sin usuario no se cancela al quitar a uno entre manos', async () => {
      const { c: admin } = await withGroup('master');
      const ghosts = [] as { id: string }[];
      for (let i = 0; i < 3; i++) ghosts.push(await admin.ok('POST', '/g/players', { name: `Fantasma${i}` }));
      for (const g of ghosts) await admin.ok('POST', `/g/table/seats/${g.id}`);
      let v = await admin.idem('/g/table/start', {});
      while (v.hand.street !== 'done') {
        v = await admin.ok('POST', '/g/table/action', { version: v.version, playerId: v.hand.toActPlayerId, action: { type: 'fold' } });
      }
      v = await admin.ok('DELETE', `/g/table/seats/${ghosts[0].id}`);
      expect(v.status).toBe('playing');
      expect(await sessionCount()).toBe(1);
    });

    it('el solo lectura puede salir (y cancelar su partida) pero no anular ni borrar partidas ajenas', async () => {
      const { a, b } = await setup(0);
      const { season, ana, beto } = await seed(a);
      const closedId = await closedSession(a, season.id, ana, beto);
      for (const c of [a, b]) await c.ok('POST', '/g/table/join');
      await a.idem('/g/table/start', {});
      expect((await b.call('DELETE', `/g/sessions/${closedId}`)).body.error).toBe('read_only');
      expect((await b.call('POST', `/g/sessions/${closedId}/void`, {}, 'lector-anular-2')).body.error).toBe('read_only');
      expect((await b.call('DELETE', `/g/sessions/${(await view(b)).sessionId}`)).body.error).toBe('read_only');
      await b.ok('POST', '/g/table/leave');
      expect((await a.ok('GET', `/g/sessions/${closedId}`)).status).toBe('closed');
    });
  });

  describe('ciegas por tiempo', () => {
    const rewind = (minutes: number) => conn.pool.query(`update poker_tables set blinds_started_at = now() - make_interval(mins => $1)`, [minutes]);

    async function twoAtTable(body: object = {}) {
      const ctx = await setup();
      await ctx.a.ok('POST', '/g/table/join');
      await ctx.b.ok('POST', '/g/table/join');
      const v = await ctx.a.idem('/g/table/start', body);
      return { ...ctx, v };
    }

    it('por defecto se duplican cada 15 minutos y la vista dice cuándo sube', async () => {
      const { v } = await twoAtTable();
      expect(v.blinds).toMatchObject({ minutes: 15, level: 0, small: 10, big: 20, atCap: false });
      expect([v.smallBlind, v.bigBlind]).toEqual([10, 20]);
      const left = new Date(v.blinds.nextAt).getTime() - new Date(v.serverTime).getTime();
      expect(left).toBeGreaterThan(14 * 60_000);
      expect(left).toBeLessThanOrEqual(15 * 60_000);
    });

    it('la suba entra en la mano siguiente, nunca en medio de la que está en juego', async () => {
      const { a, byPlayer, v } = await twoAtTable({ blindMinutes: 5 });
      expect(v.hand.pot).toBe(30);
      await rewind(6);
      const mid = await view(a);
      // Ya corresponde el nivel 1, pero la mano en curso conserva sus ciegas.
      expect(mid.blinds).toMatchObject({ level: 1, small: 20, big: 40 });
      expect([mid.smallBlind, mid.bigBlind, mid.hand.pot]).toEqual([10, 20, 30]);
      const done = await act(byPlayer(mid.hand.toActPlayerId), mid, { type: 'fold' });
      expect(done.hand.street).toBe('done');
      // Sin mano en juego, se muestran las que usará la próxima.
      expect([done.smallBlind, done.bigBlind]).toEqual([20, 40]);
      const next = await a.ok('POST', '/g/table/deal');
      expect([next.smallBlind, next.bigBlind, next.hand.pot]).toEqual([20, 40, 60]);
    });

    it('la ciega grande no pasa de la mitad de la entrada', async () => {
      const { a, byPlayer, v } = await twoAtTable({ blindMinutes: 5 });
      await rewind(5 * 60);
      const folded = await act(byPlayer(v.hand.toActPlayerId), v, { type: 'fold' });
      expect(folded.blinds).toMatchObject({ level: 4, small: 160, big: 320, atCap: true, nextAt: null });
      const next = await a.ok('POST', '/g/table/deal');
      expect([next.smallBlind, next.bigBlind]).toEqual([160, 320]);
    });

    it('con 0 nunca se duplican; el valor se valida', async () => {
      const { a, b } = await setup();
      await a.ok('POST', '/g/table/join');
      await b.ok('POST', '/g/table/join');
      expect((await a.call('POST', '/g/table/start', { blindMinutes: 3 }, 'blind-key-0001')).body.error).toBe('invalid_blind_time');
      expect((await a.call('POST', '/g/table/start', { blindMinutes: 121 }, 'blind-key-0002')).status).toBe(400);
      const v = await a.idem('/g/table/start', { blindMinutes: 0 });
      expect(v.blinds).toMatchObject({ minutes: 0, level: 0, big: 20, atCap: true, nextAt: null });
      await rewind(5 * 60);
      expect((await view(a)).blinds).toMatchObject({ level: 0, big: 20, nextAt: null });
    });
  });

  describe('tiempo por turno', () => {
    const expire = () => conn.pool.query(`update poker_tables set turn_deadline = now() - interval '1 second'`);
    const seatsOf = async () => (await conn.pool.query('select player_id, status, timeouts from poker_seats')).rows;

    async function started(turnSeconds?: number) {
      const ctx = await setup();
      await ctx.a.ok('POST', '/g/table/join');
      await ctx.b.ok('POST', '/g/table/join');
      const v = await ctx.a.idem('/g/table/start', turnSeconds === undefined ? {} : { turnSeconds });
      return { ...ctx, v };
    }

    it('por defecto, 45 segundos por turno', async () => {
      const { v } = await started();
      expect(v.turnSeconds).toBe(45);
    });

    it('arma el vencimiento del turno y informa la hora del servidor', async () => {
      const { v } = await started(30);
      expect(v.turnSeconds).toBe(30);
      const left = new Date(v.turnDeadline).getTime() - new Date(v.serverTime).getTime();
      expect(left).toBeGreaterThan(28_000);
      expect(left).toBeLessThanOrEqual(30_000);
    });

    it('sin límite no hay vencimiento; el valor se valida', async () => {
      const { a, b } = await setup();
      await a.ok('POST', '/g/table/join');
      await b.ok('POST', '/g/table/join');
      expect((await a.call('POST', '/g/table/start', { turnSeconds: 5 }, 'turn-key-0001')).body.error).toBe('invalid_turn_time');
      expect((await a.call('POST', '/g/table/start', { turnSeconds: 301 }, 'turn-key-0002')).status).toBe(400);
      const v = await a.idem('/g/table/start', { turnSeconds: 0 });
      expect([v.turnSeconds, v.turnDeadline]).toEqual([0, null]);
      await expire();
      expect(await sweepTurns(app)).toEqual([]);
    });

    it('al vencer, el servidor se retira por quien debe igualar', async () => {
      const { a, b, v } = await started(10);
      expect(await sweepTurns(app)).toEqual([]); // todavía hay tiempo
      await expire();
      expect(await sweepTurns(app)).toEqual([a.groupId]);
      const after = await view(b);
      expect(after.hand.street).toBe('done');
      expect(after.hand.lastAction).toEqual({ playerId: v.hand.toActPlayerId, type: 'fold', auto: true });
      expect(after.version).toBeGreaterThan(v.version);
      expect(after.turnDeadline).toBeNull();
      expect((await seatsOf()).find(s => s.player_id === v.hand.toActPlayerId)?.timeouts).toBe(1);
      expect(await sweepTurns(app)).toEqual([]); // ya no hay turno
    });

    it('si puede pasar, pasa; la mano sigue con un vencimiento nuevo', async () => {
      const { byPlayer, v } = await started(10);
      const sb = byPlayer(v.hand.toActPlayerId);
      let cur = await act(sb, v, { type: 'call' });
      await expire();
      await sweepTurns(app);
      cur = await view(sb);
      expect(cur.hand.lastAction).toMatchObject({ type: 'check', auto: true });
      expect(cur.hand.street).toBe('flop');
      expect(new Date(cur.turnDeadline).getTime()).toBeGreaterThan(Date.now());
    });

    it('dos vencimientos seguidos sacan al jugador; actuar a tiempo reinicia el contador', async () => {
      const { byPlayer, v } = await started(10);
      const actor = byPlayer(v.hand.toActPlayerId);
      await conn.pool.query(`update poker_seats set timeouts = 1 where player_id = $1`, [v.hand.toActPlayerId]);
      await act(actor, v, { type: 'call' }); // actuó: contador a 0
      expect((await seatsOf()).find(s => s.player_id === v.hand.toActPlayerId)?.timeouts).toBe(0);

      const second = await started(10);
      await conn.pool.query(`update poker_seats set timeouts = 1 where player_id = $1`, [second.v.hand.toActPlayerId]);
      await expire();
      await sweepTurns(app);
      const out = (await view(second.a)).seats.find((s: { playerId: string }) => s.playerId === second.v.hand.toActPlayerId);
      expect(out.status).toBe('out');
      // Volver a sentarse reinicia el contador y no suma otro vencimiento.
      await second.byPlayer(second.v.hand.toActPlayerId).ok('POST', '/g/table/join');
      expect((await seatsOf()).find(s => s.player_id === second.v.hand.toActPlayerId)).toMatchObject({ status: 'sitting', timeouts: 0 });
    });
  });

  describe('WebSocket', () => {
    const wsUrl = (c: Client) => `/api/v1/groups/${c.groupId}/table/ws`;
    const nextMessage = (ws: Awaited<ReturnType<typeof app.injectWS>>) =>
      new Promise<{ type: string; version?: number }>(resolve => ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString()))));
    const closeCode = (ws: Awaited<ReturnType<typeof app.injectWS>>) => new Promise<number>(resolve => ws.once('close', (c: number) => resolve(c)));

    it('avisa a los conectados cuando cambia la mesa, sin datos de la mano', async () => {
      const { a, b } = await setup();
      await a.ok('POST', '/g/table/join');
      await b.ok('POST', '/g/table/join');
      const ws = await app.injectWS(wsUrl(a));
      const ready = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'auth', token: b.token }));
      expect(await ready).toEqual({ type: 'ready' });
      const changed = nextMessage(ws);
      const v = await a.idem('/g/table/start', {});
      expect(await changed).toEqual({ type: 'changed', version: v.version });

      const action = nextMessage(ws);
      const mine = await view(a);
      const actor = mine.hand.legal ? a : b;
      const cur = await view(actor);
      await act(actor, cur, { type: 'fold' });
      const msg = await action;
      expect(msg.type).toBe('changed');
      expect(Object.keys(msg).sort()).toEqual(['type', 'version']);
      ws.close();
    });

    it('el latido de presencia no genera avisos', async () => {
      const { a, b } = await setup();
      await a.ok('POST', '/g/table/join');
      const ws = await app.injectWS(wsUrl(a));
      const ready = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'auth', token: a.token }));
      await ready;
      let received = 0;
      ws.on('message', () => { received++; });
      await a.ok('POST', '/g/table/join'); // ya sentada: solo renueva la presencia
      await new Promise(r => setTimeout(r, 300));
      expect(received).toBe(0);
      await b.ok('POST', '/g/table/join'); // llega alguien nuevo: sí avisa
      await new Promise(r => setTimeout(r, 300));
      expect(received).toBe(1);
      ws.close();
    });

    describe('video', () => {
      type Msg = { type: string; kind?: string; from?: string; playerId?: string | null; data?: unknown };
      /** Conecta y autentica; guarda lo que llega para poder revisarlo después. */
      const join = async (c: Client) => {
        const ws = await app.injectWS(wsUrl(c));
        const inbox: Msg[] = [];
        ws.on('message', (d: Buffer) => inbox.push(JSON.parse(d.toString())));
        ws.send(JSON.stringify({ type: 'auth', token: c.token }));
        await vi.waitFor(() => expect(inbox.some(m => m.type === 'ready')).toBe(true));
        return { ws, inbox, rtc: () => inbox.filter(m => m.type === 'rtc') };
      };
      const settle = () => new Promise(r => setTimeout(r, 150));

      it('avisa a los demás cuando alguien empieza y corta su transmisión', async () => {
        const { a, b } = await setup();
        const pa = await join(a);
        const pb = await join(b);
        pa.ws.send(JSON.stringify({ type: 'rtc', kind: 'start' }));
        await vi.waitFor(() => expect(pb.rtc()).toHaveLength(1));
        expect(pb.rtc()[0]).toMatchObject({ kind: 'start', playerId: expect.any(String) });
        expect(pa.rtc()).toHaveLength(0); // quien transmite no recibe su propio aviso

        pa.ws.send(JSON.stringify({ type: 'rtc', kind: 'stop' }));
        await vi.waitFor(() => expect(pb.rtc()).toHaveLength(2));
        expect(pb.rtc()[1]).toMatchObject({ kind: 'stop', from: pb.rtc()[0]!.from });
        pa.ws.close(); pb.ws.close();
      });

      it('al conectarse, informa quién ya está transmitiendo, y si se cae avisa que cortó', async () => {
        const { a, b } = await setup();
        const pa = await join(a);
        pa.ws.send(JSON.stringify({ type: 'rtc', kind: 'start' }));
        await settle();
        const pb = await join(b);
        await vi.waitFor(() => expect(pb.rtc()).toHaveLength(1));
        expect(pb.rtc()[0]).toMatchObject({ kind: 'start' });

        pa.ws.terminate(); // corte abrupto, como una pestaña cerrada o sin red
        await vi.waitFor(() => expect(pb.rtc()).toHaveLength(2));
        expect(pb.rtc()[1]).toMatchObject({ kind: 'stop' });
        pb.ws.close();
      });

      it('la negociación va solo a la conexión indicada, con el remitente puesto por el servidor', async () => {
        const { a, b } = await setup();
        const pa = await join(a);
        const pb = await join(b);
        pa.ws.send(JSON.stringify({ type: 'rtc', kind: 'start' }));
        await vi.waitFor(() => expect(pb.rtc()).toHaveLength(1));
        const broadcaster = pb.rtc()[0]!.from!;

        pb.ws.send(JSON.stringify({ type: 'rtc', kind: 'watch', to: broadcaster, from: 'falso' }));
        await settle();
        expect(pa.rtc()).toHaveLength(0); // el campo "from" enviado por el cliente no es válido: se descarta
        pb.ws.send(JSON.stringify({ type: 'rtc', kind: 'watch', to: broadcaster }));
        await vi.waitFor(() => expect(pa.rtc()).toHaveLength(1));
        expect(pa.rtc()[0]).toMatchObject({ kind: 'watch' });
        expect(pa.rtc()[0]!.from).not.toBe(broadcaster);

        pa.ws.send(JSON.stringify({ type: 'rtc', kind: 'offer', to: pa.rtc()[0]!.from, data: { type: 'offer', sdp: 'v=0' } }));
        pa.ws.send(JSON.stringify({ type: 'rtc', kind: 'offer', to: pa.rtc()[0]!.from, data: { type: 'offer', sdp: 'v=0' } }));
        await vi.waitFor(() => expect(pb.rtc().filter(m => m.kind === 'offer')).toHaveLength(2));
        expect(pb.rtc().at(-1)!.data).toEqual({ type: 'offer', sdp: 'v=0' });
        pa.ws.close(); pb.ws.close();
      });

      it('descarta mensajes mal formados y los dirigidos mal', async () => {
        const { a, b } = await setup();
        const pa = await join(a);
        const pb = await join(b);
        for (const bad of [
          { type: 'rtc', kind: 'nada' },
          { type: 'rtc', kind: 'offer' }, // falta el destino
          { type: 'rtc', kind: 'start', to: 'x' }, // start no se dirige
          { type: 'otra-cosa' },
        ]) pa.ws.send(JSON.stringify(bad));
        pa.ws.send('no es json');
        await settle();
        expect(pb.rtc()).toHaveLength(0);
        pa.ws.close(); pb.ws.close();
      });
    });

    /** Conecta y autentica un socket; devuelve también los mensajes que va recibiendo. */
    async function connect(c: Client, groupId = c.groupId) {
      const ws = await app.injectWS(`/api/v1/groups/${groupId}/table/ws`);
      const received: { type: string; [k: string]: unknown }[] = [];
      const ready = nextMessage(ws);
      ws.send(JSON.stringify({ type: 'auth', token: c.token }));
      expect(await ready).toEqual({ type: 'ready' });
      ws.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));
      return { ws, received };
    }
    const emojis = (r: { type: string; [k: string]: unknown }[]) => r.filter(m => m.type === 'emoji');
    const settle = (ms = 250) => new Promise(r => setTimeout(r, ms));

    it('un emoji llega a todos los conectados, incluido quien lo mandó, con su nombre y sin guardarse', async () => {
      const { a, b, pid } = await setup();
      const sa = await connect(a);
      const sb = await connect(b);
      sa.ws.send(JSON.stringify({ type: 'emoji', id: '1f602' }));
      await settle();
      const expected = { type: 'emoji', id: '1f602', playerId: pid[0], name: 'J0' };
      expect(emojis(sa.received)).toEqual([expected]);
      expect(emojis(sb.received)).toEqual([expected]);
      // Nada queda en la base: es efímero.
      expect((await conn.pool.query('select count(*)::int as n from poker_actions')).rows[0].n).toBe(0);
      sa.ws.close();
      sb.ws.close();
    });

    it('quien mira sin jugador (administrador) también puede mandar: va con el nombre de su usuario', async () => {
      const { c: admin, group } = await withGroup('master');
      const reader = await login('lector');
      await reader.ok('POST', '/groups/join', { inviteCode: group.inviteCode });
      reader.groupId = group.id;
      const sr = await connect(reader);
      const sa = await connect(admin);
      sa.ws.send(JSON.stringify({ type: 'emoji', id: '1f44f' }));
      await settle();
      expect(emojis(sr.received)).toEqual([{ type: 'emoji', id: '1f44f', playerId: null, name: 'master' }]);
      sa.ws.close();
      sr.ws.close();
    });

    it('solo acepta la paleta fija, y a uno por conexión cada ~1,5 s', async () => {
      const { a, b } = await setup();
      const sa = await connect(a);
      const sb = await connect(b);
      // Fuera de la paleta o mal formados: se ignoran (y no gastan el turno del límite).
      for (const bad of [{ id: '1f4a9' }, { id: '<script>' }, { id: 5 }, {}, { id: '1f602', extra: true }]) {
        sa.ws.send(JSON.stringify({ type: 'emoji', ...bad }));
      }
      sa.ws.send('no es json');
      await settle();
      expect(emojis(sb.received)).toEqual([]);
      // Dos seguidos: pasa el primero.
      sa.ws.send(JSON.stringify({ type: 'emoji', id: '1f525' }));
      sa.ws.send(JSON.stringify({ type: 'emoji', id: '1f62d' }));
      await settle();
      expect(emojis(sb.received).map(m => m.id)).toEqual(['1f525']);
      await settle(1500);
      sa.ws.send(JSON.stringify({ type: 'emoji', id: '1f62d' }));
      await settle();
      expect(emojis(sb.received).map(m => m.id)).toEqual(['1f525', '1f62d']);
      sa.ws.close();
      sb.ws.close();
    });

    it('la paleta incluye mono, pescador y puño, y rechaza lo que no está', async () => {
      const ids = TABLE_EMOJIS.map(e => e.id);
      expect(TABLE_EMOJIS.filter(e => ['Mono', 'Pescador', 'Puño'].includes(e.label)).map(e => e.id)).toEqual(['1f412', '1f3a3', '1f44a']);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(Value.Check(EmojiClientMessage, { type: 'emoji', id })).toBe(true);
      for (const id of ['1f4a9', '1f435', '', '1F602']) expect(Value.Check(EmojiClientMessage, { type: 'emoji', id })).toBe(false);
    });

    it('no cruza de grupo, y sin autenticar no se puede mandar', async () => {
      const { a } = await setup();
      const { c: other } = await withGroup('ajeno-admin');
      const sa = await connect(a);
      const so = await connect(other);
      sa.ws.send(JSON.stringify({ type: 'emoji', id: '1f60e' }));
      await settle();
      expect(emojis(sa.received)).toHaveLength(1);
      expect(emojis(so.received)).toEqual([]);
      sa.ws.close();
      so.ws.close();

      const anon = await app.injectWS(wsUrl(a));
      const anonClosed = closeCode(anon);
      anon.send(JSON.stringify({ type: 'emoji', id: '1f602' }));
      expect(await anonClosed).toBe(4401);
    });

    it('rechaza token inválido, mensaje sin auth y a quien no es del grupo', async () => {
      const { a } = await setup();
      const bad = await app.injectWS(wsUrl(a));
      const badClosed = closeCode(bad);
      bad.send(JSON.stringify({ type: 'auth', token: 'basura' }));
      expect(await badClosed).toBe(4401);

      const noAuth = await app.injectWS(wsUrl(a));
      const noAuthClosed = closeCode(noAuth);
      noAuth.send(JSON.stringify({ type: 'hola' }));
      expect(await noAuthClosed).toBe(4401);

      const outsider = await login('ajeno');
      const out = await app.injectWS(wsUrl(a));
      const outClosed = closeCode(out);
      out.send(JSON.stringify({ type: 'auth', token: outsider.token }));
      expect(await outClosed).toBe(4403);
      expect(app.tableHub.count(a.groupId)).toBe(0);
    });
  });
});
