import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { ApiError } from './errors';
import { connect, runMigrations } from './db/client';
import { generateOpenApi, openapiPath } from './openapi';
import { planImport } from './backup';

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
  async call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, key?: string) {
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
  async ok(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, key?: string) {
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

async function withGroup(sub = 'ana') {
  const c = await login(sub);
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
    await b.ok('POST', '/groups', { name: 'Otro' });
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
    await c.ok('DELETE', '/g/members/me');
    expect((await c.call('GET', '/g/seasons')).status).toBe(403);
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
    for (const path of ['/g', '/g/players', '/g/seasons', '/g/debts', '/g/ranking', '/g/backup/export', '/g/debts/reorganize-status']) {
      expect((await other.call('GET', path)).status).toBe(403);
    }
    expect((await other.call('POST', '/g/players', { name: 'x' })).status).toBe(403);
  });
  it('los recursos de otro grupo dan 404 desde el grupo propio', async () => {
    const { c: a } = await withGroup('ana');
    const { season, ana, beto } = await seed(a);
    const sessionId = await closedSession(a, season.id, ana, beto);
    const debt = (await a.ok('GET', '/g/debts'))[0];

    const { c: b } = await withGroup('beto');
    expect((await b.call('GET', `/g/sessions/${sessionId}`)).status).toBe(404);
    expect((await b.call('GET', `/g/players/${ana.id}/stats`)).status).toBe(404);
    expect((await b.call('PATCH', `/g/players/${ana.id}`, { name: 'hack' })).status).toBe(404);
    expect((await b.call('DELETE', `/g/seasons/${season.id}`)).status).toBe(404);
    expect((await b.call('POST', `/g/debts/${debt.id}/mark-paid`, undefined, 'clave-aislada')).status).toBe(404);
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
  it('bug 1: cerrar dos veces da 409 aunque las deudas se hayan consolidado', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const first = await closedSession(c, season.id, ana, beto);
    await closedSession(c, season.id, ana, beto);
    expect(await c.ok('GET', '/g/debts')).toHaveLength(1);
    expect((await c.call('POST', `/g/sessions/${first}/close`, {}, 'clave-recierre')).body.error).toBe('session_closed');
    expect((await c.ok('GET', '/g/debts'))[0].pendingAmount).toBe(100);
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
  it('los participantes sin resultado requieren confirmación y quedan fuera de las deudas', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 200 });
    const r = await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-faltan-1');
    expect(r.body.missingResults).toEqual([beto.id]);
    // Con el pozo exacto igual se confirma, porque falta un resultado.
    const closed = await c.ok('POST', `/g/sessions/${s.id}/close`, { confirmedDiff: 0 }, 'clave-faltan-2');
    expect(closed.debts).toEqual([]);
  });
  it('bug 6: borrar una partida: libre sin pagos, 409 con pagos o neteada', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const free = await closedSession(c, season.id, ana, beto);
    expect((await c.ok('DELETE', `/g/sessions/${free}`)).deleted).toBe(true);
    expect(await c.ok('GET', '/g/debts')).toEqual([]);

    const paid = await closedSession(c, season.id, ana, beto);
    const [debt] = await c.ok('GET', '/g/debts');
    await c.idem(`/g/debts/${debt.id}/payments`, { amount: 1 });
    expect((await c.call('DELETE', `/g/sessions/${paid}`)).body.error).toBe('session_debts_locked');

    await c.idem(`/g/debts/${debt.id}/mark-paid`);
    const a = await closedSession(c, season.id, ana, beto);
    const b = await closedSession(c, season.id, ana, beto);
    expect((await c.call('DELETE', `/g/sessions/${a}`)).body.error).toBe('session_debts_locked');
    expect((await c.call('DELETE', `/g/sessions/${b}`)).body.error).toBe('session_debts_locked');
  });
  it('bug 7: tras netear, la vista de la partida marca los ítems como merged', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const a = await closedSession(c, season.id, ana, beto);
    const before = await c.ok('GET', `/g/sessions/${a}/debts`);
    expect(before.items[0]).toMatchObject({ state: 'open', fromId: beto.id, amount: 50 });
    expect(before.items[0].debt.pendingAmount).toBe(50);
    expect(before.balances[0]).toMatchObject({ playerId: ana.id, balance: 50 });
    await closedSession(c, season.id, ana, beto);
    expect((await c.ok('GET', `/g/sessions/${a}/debts`)).items[0]).toMatchObject({ state: 'merged', debt: null });
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
  it('cierres paralelos generan las deudas una sola vez', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 50 });
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => c.call('POST', `/g/sessions/${s.id}/close`, {}, `cierre-paralelo-${i}`)));
    expect(rs.filter(r => r.status === 200)).toHaveLength(1);
    expect(rs.filter(r => r.status === 409)).toHaveLength(4);
    const debts = await c.ok('GET', '/g/debts');
    expect(debts).toHaveLength(1);
    expect(debts[0].pendingAmount).toBe(50);
  });
  it('pagos paralelos no superan lo pendiente', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const [debt] = await c.ok('GET', '/g/debts');
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      c.call('POST', `/g/debts/${debt.id}/payments`, { amount: 20 }, `pago-paralelo-${i}`)));
    expect(rs.filter(r => r.status === 200)).toHaveLength(2);
    const [after] = await c.ok('GET', '/g/debts');
    expect(after.pendingAmount).toBe(10);
    expect(after.payments).toHaveLength(2);
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
  it('rollback: si falla la generación de deudas, la partida sigue abierta', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const s = await c.idem(`/g/seasons/${season.id}/sessions`, { playerIds: [ana.id, beto.id], initialBuyIn: 100 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${ana.id}`, { finalAmount: 150 });
    await c.ok('PATCH', `/g/sessions/${s.id}/participants/${beto.id}`, { finalAmount: 50 });
    await conn.pool.query('ALTER TABLE debts ADD CONSTRAINT ck_test_falla CHECK (original_amount < 0) NOT VALID');
    try {
      expect((await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-rollback')).status).toBe(500);
      expect((await c.ok('GET', `/g/sessions/${s.id}`)).status).toBe('active');
    } finally {
      await conn.pool.query('ALTER TABLE debts DROP CONSTRAINT ck_test_falla');
    }
    expect((await c.call('POST', `/g/sessions/${s.id}/close`, {}, 'clave-rollback')).status).toBe(200);
  });
});

describe('deudas', () => {
  it('pago parcial, exceso y saldado', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 50);
    const [debt] = await c.ok('GET', '/g/debts');
    expect(debt).toMatchObject({ sourceType: 'session', status: 'pending' });
    const over = await c.call('POST', `/g/debts/${debt.id}/payments`, { amount: 51 }, 'clave-exceso');
    expect(over.status).toBe(422);
    expect(over.body).toMatchObject({ error: 'amount_exceeds_pending', max: 50 });
    const partial = await c.idem(`/g/debts/${debt.id}/payments`, { amount: 20, note: ' efectivo ' });
    expect(partial).toMatchObject({ status: 'partial', pendingAmount: 30, payments: [{ amount: 20, note: 'efectivo' }] });
    const paid = await c.idem(`/g/debts/${debt.id}/mark-paid`);
    expect(paid).toMatchObject({ status: 'paid', pendingAmount: 0 });
    expect(paid.payments).toHaveLength(2);
    expect((await c.call('POST', `/g/debts/${debt.id}/payments`, { amount: 1 }, 'clave-pagada')).body.error).toBe('debt_paid');
    expect(await c.ok('GET', '/g/debts/pending-by-debtor')).toEqual([]);
  });
  it('saldar varias es atómico: un id inválido revierte todo', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto);
    const [debt] = await c.ok('GET', '/g/debts');
    const bad = await c.call('POST', '/g/debts/mark-paid', { debtIds: [debt.id, 'nada'] }, 'clave-atomica');
    expect(bad.status).toBe(404);
    expect((await c.ok('GET', '/g/debts'))[0].status).toBe('pending');
    const [paid] = await c.ok('POST', '/g/debts/mark-paid', { debtIds: [debt.id] }, 'clave-atomica-2');
    expect(paid.status).toBe('paid');
  });
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
  it('una manual consolidada no se borra, y bug 9 no duplica balance', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto, 100);
    const [merged] = await c.ok('POST', '/g/debts/manual', { fromPlayerId: beto.id, toPlayerId: ana.id, amount: 50 });
    expect(merged).toMatchObject({ sourceType: 'manual', isConsolidated: true, pendingAmount: 150, manualAmount: 50 });
    expect((await c.call('DELETE', `/g/debts/manual/${merged.id}`)).body.error).toBe('debt_not_deletable');
    expect(await c.ok('GET', `/g/players/${ana.id}/stats`)).toMatchObject({ sessionBalance: 100, manualDebtsNet: 50, totalBalance: 150 });
  });
  it('una deuda de partida no se borra por la ruta de manuales', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await closedSession(c, season.id, ana, beto);
    const [debt] = await c.ok('GET', '/g/debts');
    expect((await c.call('DELETE', `/g/debts/manual/${debt.id}`)).body.error).toBe('debt_not_deletable');
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
  it('bug 5: borrar una partida con deudas invalida el backup', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const caro = await c.ok('POST', '/g/players', { name: 'Caro' });
    const id = await closedSession(c, season.id, caro, beto);
    await unnetted(c, ana, beto);
    await c.ok('POST', '/g/debts/renet');
    await c.ok('DELETE', `/g/sessions/${id}`);
    expect((await c.ok('GET', '/g/debts/reorganize-status')).canUndo).toBe(false);
  });
  it('cerrar una partida invalida el backup', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    await unnetted(c, ana, beto);
    await c.ok('POST', '/g/debts/renet');
    const caro = await c.ok('POST', '/g/players', { name: 'Caro' });
    await closedSession(c, season.id, caro, ana);
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
  it('sin historial se borra; con historial se archiva y sigue en ranking', async () => {
    const { c } = await withGroup();
    const { season, ana, beto } = await seed(c);
    const caro = await c.ok('POST', '/g/players', { name: 'Caro' });
    expect((await c.ok('DELETE', `/g/players/${caro.id}`)).archived).toBe(false);
    await closedSession(c, season.id, ana, beto);
    expect((await c.ok('DELETE', `/g/players/${beto.id}`)).archived).toBe(true);
    expect((await c.ok('GET', '/g/players')).map((p: { id: string }) => p.id)).toEqual([ana.id]);
    expect(await c.ok('GET', '/g/players?includeArchived=true')).toHaveLength(2);
    const ranking = await c.ok('GET', '/g/ranking');
    expect(ranking.find((r: { playerId: string }) => r.playerId === beto.id).archived).toBe(true);
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
    expect((await c.ok('GET', '/g/debts'))[0].toPlayer.name).toBe('Anita');
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
    const debts = await c.ok('GET', `/g/players/${beto.id}/debts`);
    expect([debts.owes.length, debts.owed.length]).toEqual([1, 0]);
    expect((await c.ok('GET', `/g/ranking?seasonId=${season.id}`))[0].playerId).toBe(ana.id);
    expect(await c.ok('GET', `/g/ranking?seasonId=${other.id}`)).toEqual([]);
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
    const key = (r: { name: string; totalBalance: number; archived: boolean; totalGames: number }) => [r.name, r.totalBalance, r.archived, r.totalGames];
    expect(again.map(key)).toEqual(ranking.map(key));
    const [debt] = await copy.ok('GET', '/g/debts');
    expect(debt).toMatchObject({ manualAmount: 25, pendingAmount: 75, isConsolidated: true });
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
