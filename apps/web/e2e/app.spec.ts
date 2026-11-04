import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:3100/api/v1';
const MASTER_TOKEN = 'test:e2e-master:master@x.com:Master';
let userSeq = 0;

// Cada test arranca sin grupos: master y admins ven todos los de la base.
test.beforeEach(async ({ request }) => {
  await request.post('http://127.0.0.1:3100/e2e/reset');
});

async function apiLogin(page: Page, idToken: string): Promise<string> {
  const res = await page.request.post(`${API}/auth/google`, { data: { idToken } });
  return (await res.json()).token;
}

/** Google se reemplaza por el verificador de test: nunca existe en el build de producción. */
async function login(page: Page, name: string, role: 'master' | 'admin' | 'reader' = 'admin'): Promise<string> {
  const sub = `${name}-${Date.now()}-${++userSeq}`;
  const email = `${sub}@x.com`.toLowerCase();
  if (role === 'admin') {
    const master = await apiLogin(page, MASTER_TOKEN);
    await page.request.post(`${API}/admin/admins`, { headers: { authorization: `Bearer ${master}` }, data: { email } });
  }
  const token = await apiLogin(page, role === 'master' ? MASTER_TOKEN : `test:${sub}:${email}:${name}`);
  await page.addInitScript(t => localStorage.setItem('pc_token', t), token);
  return token;
}

async function checkPage(page: Page, where: string) {
  await page.waitForLoadState('networkidle');
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter(v => ['serious', 'critical'].includes(v.impact ?? '')).map(v => `${where}: ${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow, `${where}: scroll horizontal`).toBe(false);
}

async function createGroup(page: Page, name = 'Los viernes'): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Nombre del grupo').fill(name);
  await page.getByRole('button', { name: 'Crear grupo' }).click();
  const code = await page.getByTestId('invite-code').innerText();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Ranking', exact: true })).toBeVisible();
  return code;
}

async function addPlayer(page: Page, name: string) {
  await page.getByRole('button', { name: '+ Agregar' }).click();
  await page.getByLabel('Nombre').fill(name);
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
}

const nav = (page: Page, label: string) => page.getByRole('link', { name: label }).locator('visible=true').first().click();

test('partida completa: grupo, compras, cierre con diferencia, pagos y stats', async ({ page, browser }) => {
  await login(page, 'Seba');
  const code = await createGroup(page);

  await nav(page, 'Jugadores');
  await addPlayer(page, 'Ana');
  await addPlayer(page, 'Beto');

  await nav(page, 'Temporadas');
  await page.getByRole('link', { name: 'Ver partidas' }).click();
  await page.getByRole('button', { name: '+ Nueva partida' }).click();
  await page.getByLabel('Compra inicial por jugador').fill('100,50');
  await page.getByRole('button', { name: 'Todos' }).click();
  await expect(page.getByText('Pozo inicial:')).toContainText('$201');
  await page.getByRole('button', { name: 'Crear partida' }).click();
  await expect(page.getByTestId('pot')).toHaveText('$201');

  // Recompra de Ana.
  const ana = page.getByTestId('player-Ana');
  await ana.getByRole('button', { name: '+ Compra' }).click();
  await page.getByLabel('¿Cuánto compra en fichas?').fill('50');
  await page.getByRole('button', { name: 'Registrar' }).click();
  await expect(page.getByTestId('pot')).toHaveText('$251');

  // Un segundo miembro ve la misma mesa.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await login(page2, 'Ana', 'reader');
  await page2.goto('/');
  await page2.getByLabel('Código de invitación').fill(code);
  await page2.getByRole('button', { name: 'Unirme' }).click();
  await page2.getByRole('button', { name: 'Soy Ana' }).click();
  await expect(page2.getByRole('heading', { name: 'Ranking', exact: true })).toBeVisible();
  await page2.goto(page.url());
  await expect(page2.getByTestId('pot')).toHaveText('$251');
  await expect(page2.getByRole('button', { name: '+ Compra' })).toHaveCount(0);
  await context2.close();

  // Resultados con faltante de 21.
  await ana.getByRole('button', { name: 'Resultado final' }).click();
  await page.getByLabel('¿Con cuánto terminó?').fill('180');
  await page.getByRole('button', { name: 'Guardar' }).click();
  const beto = page.getByTestId('player-Beto');
  await beto.getByRole('button', { name: 'Resultado final' }).click();
  await page.getByLabel('¿Con cuánto terminó?').fill('50');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByTestId('diff')).toHaveText('Faltan $21');

  await page.getByRole('button', { name: 'Cerrar partida' }).click();
  const closing = page.getByRole('dialog');
  await expect(closing).toContainText('El pozo no cuadra: faltan $21');
  // Saldo final por defecto: saldo previo (0) + resultado de la partida.
  await expect(closing.getByLabel('Saldo de Ana')).toHaveValue('29,5');
  await expect(closing.getByLabel('Saldo de Beto')).toHaveValue('-50,5');
  await closing.getByRole('button', { name: 'Cerrar partida' }).click();

  // Saldos: Ana +29,50, Beto -50,50.
  await expect(page.getByRole('heading', { name: 'Saldos de la partida' })).toBeVisible();
  // Partida cerrada: sin edición.
  await page.getByRole('link', { name: '← Partida' }).click();
  await expect(page.getByText('✓ Partida cerrada')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Compra' })).toHaveCount(0);

  await page.goto('/debts');
  await expect(page.getByTestId('balance-Ana')).toContainText('+$29,5');
  await expect(page.getByTestId('balance-Beto')).toContainText('$-50,5');
  await page.getByRole('button', { name: '+ Registrar pago' }).click();
  const pending = page.getByRole('dialog');
  await pending.getByLabel('Monto').fill('10');
  await pending.getByLabel('Nota (opcional)').fill('efectivo');
  await pending.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(page.getByText('efectivo')).toBeVisible();
  await expect(page.getByTestId('balance-Ana')).toContainText('+$19,5');
  // Sin monto, paga lo máximo posible y deja en cero al acreedor.
  await page.getByRole('button', { name: '+ Registrar pago' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pagar $19,5' }).click();
  await expect(page.getByTestId('balance-Ana')).toHaveCount(0);
  await expect(page.getByTestId('payment-item')).toHaveCount(2);

  // Ranking y stats.
  await nav(page, 'Ranking');
  await page.getByRole('link', { name: /Ana/ }).first().click();
  await expect(page.getByTestId('hero-balance')).toHaveText('+$29,5');
  await expect(page.getByText('Compras y rachas')).toBeVisible();
});

const backup = (extra: object = {}) => ({
  exportedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '1.1.0',
  data: {
    poker_players: [
      { id: 'p1', name: 'Ana', createdAt: '2025-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'Beto', createdAt: '2025-01-01T00:00:00.000Z' },
    ],
    poker_seasons: [{ id: 't1', name: 'Importada', createdAt: '2025-01-01T00:00:00.000Z', closedAt: null, status: 'active' }],
    poker_sessions: [
      {
        id: 's1', name: 'Noche uno', createdAt: '2025-02-01T22:00:00.000Z', closedAt: '2025-02-02T02:00:00.000Z', status: 'closed', seasonId: 't1',
        participants: [
          { playerId: 'p1', name: 'Ana', finalAmount: 150, buys: [{ amount: 100, timestamp: '2025-02-01T22:00:00.000Z' }] },
          { playerId: 'p3', name: 'Fantasma', finalAmount: 50, buys: [{ amount: 100, timestamp: '2025-02-01T22:00:00.000Z' }] },
        ],
      },
      {
        id: 's2', name: 'Noche dos', createdAt: '2025-03-01T22:00:00.000Z', closedAt: '2025-03-02T02:00:00.000Z', status: 'closed', seasonId: 't1',
        participants: [
          { playerId: 'p1', name: 'Ana', finalAmount: 40, buys: [{ amount: 100, timestamp: '2025-03-01T22:00:00.000Z' }] },
          { playerId: 'p2', name: 'Beto', finalAmount: 160, buys: [{ amount: 100, timestamp: '2025-03-01T22:00:00.000Z' }] },
        ],
      },
    ],
    poker_debts: [
      { id: 'd1', fromPlayer: { id: 'p2', name: 'Beto' }, toPlayer: { id: 'p1', name: 'Ana' }, sessionId: 'neteado', sessionName: 'Vieja A', originalAmount: 50, pendingAmount: 50, status: 'pending', payments: [], createdAt: '2025-01-01T00:00:00.000Z', isConsolidated: true },
      { id: 'd2', fromPlayer: { id: 'p2', name: 'Beto' }, toPlayer: { id: 'p1', name: 'Ana' }, sessionId: 'neteado', sessionName: 'Vieja B', originalAmount: 30, pendingAmount: 30, status: 'pending', payments: [], createdAt: '2025-01-01T00:00:00.000Z', isConsolidated: true },
    ],
    ...extra,
  },
});

async function importBackup(page: Page) {
  await nav(page, 'Config');
  await page.getByTestId('backup-file').setInputFiles({
    name: 'PokerControl.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup())),
  });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('3 jugadores (1 reconstruidos como archivados)');
  await dialog.getByRole('button', { name: 'Reemplazar todo' }).click();
  await expect(page.getByText('Backup importado.')).toBeVisible();
}

/** Cierra una partida por API: Ana +80, Beto -80. Los saldos arrancan en cero tras importar un backup. */
async function seedBalances(page: Page) {
  const token = await page.evaluate(() => localStorage.getItem('pc_token'));
  const headers = { authorization: `Bearer ${token}` };
  const [group] = await (await page.request.get(`${API}/groups`, { headers })).json();
  const base = `${API}/groups/${group.id}`;
  const [season] = await (await page.request.get(`${base}/seasons`, { headers })).json();
  const players: { id: string; name: string }[] = await (await page.request.get(`${base}/players`, { headers })).json();
  const id = (name: string) => players.find(p => p.name === name)!.id;
  let n = 0;
  const post = async (path: string, data: object) => {
    const res = await page.request.post(`${base}${path}`, { headers: { ...headers, 'idempotency-key': `seed-${Date.now()}-${++n}` }, data });
    expect(res.ok(), path).toBe(true);
    return res.json();
  };
  const session = await post(`/seasons/${season.id}/sessions`, { playerIds: [id('Ana'), id('Beto')], initialBuyIn: 100 });
  for (const [name, finalAmount] of [['Ana', 180], ['Beto', 20]] as const) {
    const res = await page.request.patch(`${base}/sessions/${session.id}/participants/${id(name)}`, { headers, data: { finalAmount } });
    expect(res.ok()).toBe(true);
  }
  await post(`/sessions/${session.id}/close`, {});
}

test('importar backup, ver saldos y registrar pagos', async ({ page }) => {
  await login(page, 'Seba');
  await createGroup(page);
  await importBackup(page);

  await nav(page, 'Temporadas');
  await expect(page.getByRole('heading', { name: 'Importada' })).toBeVisible();

  // Tras importar los saldos arrancan en cero.
  await nav(page, 'Saldos');
  await expect(page.getByText('Todos en cero')).toBeVisible();

  await seedBalances(page);
  await page.reload();
  await expect(page.getByTestId('balance-Ana')).toContainText('+$80');
  await expect(page.getByTestId('balance-Beto')).toContainText('$-80');
  // El primero de la lista es el que más tiene para cobrar.
  await expect(page.locator('[data-testid^="balance-"]').first()).toHaveAttribute('data-testid', 'balance-Ana');

  await page.getByTestId('balance-Beto').getByRole('button', { name: '+ Registrar pago' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Monto').fill('30');
  await dialog.getByLabel('Nota (opcional)').fill('transferencia');
  await dialog.getByRole('button', { name: 'Registrar pago' }).click();
  await expect(page.getByTestId('balance-Beto')).toContainText('$-50');
  await expect(page.getByTestId('payment-item')).toContainText('transferencia');

  // Actualizar saldos: Beto pagó 20 por fuera.
  await page.getByRole('button', { name: 'Actualizar saldos' }).click();
  await page.getByLabel('Saldo de Beto').fill('-30');
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByTestId('balance-Beto')).toContainText('$-30');
  await page.getByRole('button', { name: 'Actualizar saldos' }).click();
  await page.getByLabel('Saldo de Beto').fill('-50');
  await page.getByRole('dialog').getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByTestId('balance-Beto')).toContainText('$-50');

  // Deshacer el pago devuelve los saldos.
  await page.getByRole('button', { name: 'Eliminar pago de Beto' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.getByTestId('balance-Beto')).toContainText('$-80');
  await expect(page.getByTestId('payment-item')).toHaveCount(0);
});

test('el ranking es la vista inicial y arranca en la temporada activa', async ({ page }) => {
  await login(page, 'Seba');
  await createGroup(page);
  await importBackup(page);
  const scope = page.getByLabel('Alcance');
  const selected = scope.locator('option:checked');

  await page.goto('/');
  await expect(page).toHaveURL(/\/ranking$/);
  await expect(page.getByRole('heading', { name: 'Los viernes' })).toBeVisible();
  await expect(selected).toHaveText('Importada');
  await expect(page.locator('.podium')).toContainText('+$60');

  // El histórico se mantiene al recargar; el menú vuelve a la temporada activa.
  await scope.selectOption({ label: 'Histórico' });
  await expect(page).toHaveURL(/seasonId=all$/);
  await page.reload();
  await expect(selected).toHaveText('Histórico');
  await nav(page, 'Ranking');
  await expect(selected).toHaveText('Importada');

  // Sin temporada activa muestra el histórico.
  await nav(page, 'Temporadas');
  await page.getByRole('button', { name: 'Cerrar Importada' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
  await expect(page.getByText('Cerrada')).toBeVisible();
  await nav(page, 'Ranking');
  await expect(selected).toHaveText('Histórico');
});

test('invitación: compartir el link y unirse desde él', async ({ page, browser }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      value: async ({ text }: { text: string }) => { (window as unknown as { shared: string }).shared = text; },
    });
  });
  await login(page, 'Seba');
  const code = await createGroup(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Compartir por WhatsApp' }).click();
  const shared = await page.evaluate(() => (window as unknown as { shared: string }).shared);
  expect(shared).toContain('Los viernes');
  const link = shared.split('\n')[1];
  expect(link).toMatch(new RegExp(`/join/${code}$`));

  // Sin sesión pide el login sin perder el link.
  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  await visitor.goto(link);
  await expect(visitor.getByText('Iniciá sesión para unirte al grupo.')).toBeVisible();
  await expect(visitor).toHaveURL(new RegExp(`/join/${code}$`));
  await anonymous.close();

  // Con sesión se une con un clic.
  const context2 = await browser.newContext();
  const reader = await context2.newPage();
  await login(reader, 'Caro', 'reader');
  await reader.goto(link);
  await expect(reader.getByTestId('join-code')).toHaveText(code);
  await checkPage(reader, 'invitación');
  await reader.getByRole('button', { name: 'Unirme al grupo' }).click();
  await expect(reader.getByRole('heading', { name: '¿Quién sos en Los viernes?' })).toBeVisible();

  // Volver a abrirlo no falla: avisa y entra.
  await reader.goto(link);
  await reader.getByRole('button', { name: 'Unirme al grupo' }).click();
  await expect(reader.getByRole('alert')).toContainText('Ya sos miembro');
  await expect(reader.getByRole('heading', { name: '¿Quién sos en Los viernes?' })).toBeVisible();

  // Un código que ya no existe se informa y no saca de la pantalla.
  await reader.goto('/join/NOEXISTE');
  await reader.getByRole('button', { name: 'Unirme al grupo' }).click();
  await expect(reader.getByRole('alert')).toContainText('no es válido');
  await expect(reader.getByTestId('join-code')).toBeVisible();
  await context2.close();
});

test('jugadores: archivar con historial, restaurar y renombrar', async ({ page }) => {
  await login(page, 'Seba');
  await createGroup(page);
  await importBackup(page);
  await nav(page, 'Jugadores');
  await page.getByRole('button', { name: 'Ver archivados (1)' }).click();
  await expect(page.getByText('Fantasma')).toBeVisible();

  await page.getByRole('button', { name: 'Eliminar a Beto' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Eliminar' }).click();
  await expect(page.getByText('Beto tenía historial: quedó archivado.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ocultar archivados (2)' })).toBeVisible();

  await page.getByRole('button', { name: 'Renombrar a Ana' }).click();
  await page.getByLabel('Nombre').fill('Anita');
  await page.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByText('Anita')).toBeVisible();
});

test('varios grupos: el selector aísla los datos', async ({ page, isMobile }) => {
  await login(page, 'Seba');
  await createGroup(page, 'Grupo A');
  await nav(page, 'Jugadores');
  await addPlayer(page, 'SoloEnA');

  await nav(page, 'Config');
  await page.getByRole('button', { name: 'Crear o unirme a otro grupo' }).click();
  await page.getByLabel('Nombre del grupo').fill('Grupo B');
  await page.getByRole('button', { name: 'Crear grupo' }).click();
  await page.getByRole('button', { name: 'Continuar' }).click();

  await nav(page, 'Jugadores');
  await expect(page.getByText('No hay jugadores')).toBeVisible();

  if (isMobile) {
    await nav(page, 'Config');
    await page.getByLabel('Grupo activo').selectOption({ label: 'Grupo A' });
    await nav(page, 'Jugadores');
  } else {
    await page.getByTestId('group-switcher').selectOption({ label: 'Grupo A' });
  }
  await expect(page.getByRole('link', { name: 'Estadísticas de SoloEnA' })).toBeVisible();
});

test('errores: partida ajena, ruta inexistente y sesión inválida', async ({ page }) => {
  await login(page, 'Seba');
  await createGroup(page);
  await page.goto('/sessions/no-existe');
  await expect(page.getByText('Partida no encontrada')).toBeVisible();
  await page.goto('/cualquier-cosa');
  await expect(page.getByText('Página no encontrada')).toBeVisible();
  await page.evaluate(() => localStorage.setItem('pc_token', 'invalido'));
  await page.addInitScript(() => localStorage.setItem('pc_token', 'invalido'));
  await page.goto('/seasons');
  await expect(page.getByText('Compras, resultados y deudas')).toBeVisible();
});

test('roles: master, solo lectura con nick, promoción y archivados', async ({ page, browser }) => {
  await login(page, 'Master', 'master');
  const code = await createGroup(page);
  await importBackup(page);
  await seedBalances(page);

  // Un archivado sale del ranking y sigue en la partida pasada.
  await nav(page, 'Ranking');
  await expect(page.locator('.podium')).toBeVisible();
  await expect(page.getByText('Fantasma')).toHaveCount(0);
  await nav(page, 'Temporadas');
  await page.getByRole('link', { name: 'Ver partidas' }).click();
  await page.getByRole('link', { name: /Noche uno/ }).click();
  await expect(page.getByTestId('player-Fantasma')).toBeVisible();

  // Solo lectura: necesita invitación y elegir su nick.
  const context2 = await browser.newContext();
  const reader = await context2.newPage();
  await login(reader, 'Caro', 'reader');
  await reader.goto('/');
  await expect(reader.getByLabel('Nombre del grupo')).toHaveCount(0);
  await reader.getByLabel('Código de invitación').fill(code);
  await reader.getByRole('button', { name: 'Unirme' }).click();
  await expect(reader.getByRole('heading', { name: '¿Quién sos en Los viernes?' })).toBeVisible();
  await expect(reader.getByRole('button', { name: 'Soy Fantasma' })).toHaveCount(0);
  await checkPage(reader, 'nick');
  await reader.getByLabel('Tu nick').fill('ana');
  await reader.getByRole('button', { name: 'Crear mi jugador' }).click();
  await expect(reader.getByRole('alert')).toContainText('Ya existe un jugador');
  await reader.getByLabel('Tu nick').fill('Caro');
  await reader.getByRole('button', { name: 'Crear mi jugador' }).click();

  // Ve datos, sin ningún control de edición.
  await expect(reader.getByRole('heading', { name: 'Ranking', exact: true })).toBeVisible();
  await nav(reader, 'Temporadas');
  await expect(reader.getByRole('heading', { name: 'Temporadas' })).toBeVisible();
  await expect(reader.getByRole('button', { name: '+ Nueva temporada' })).toHaveCount(0);
  await nav(reader, 'Jugadores');
  await expect(reader.getByText('Caro', { exact: true })).toBeVisible();
  await expect(reader.getByRole('button', { name: '+ Agregar' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Eliminar a Ana' })).toHaveCount(0);
  await nav(reader, 'Saldos');
  await expect(reader.getByTestId('balance-Beto')).toBeVisible();
  await expect(reader.getByRole('button', { name: '+ Registrar pago' })).toHaveCount(0);
  await nav(reader, 'Config');
  await expect(reader.getByRole('heading', { name: 'Miembros (2)' })).toBeVisible();
  await expect(reader.getByTestId('settings-invite')).toHaveCount(0);
  await expect(reader.getByRole('heading', { name: 'Backup' })).toHaveCount(0);
  await expect(reader.getByTestId('admins-card')).toHaveCount(0);
  await checkPage(reader, 'configuración de solo lectura');

  // El master lo promueve, y nombra por email a alguien que todavía no ingresó.
  await nav(page, 'Config');
  const admins = page.getByTestId('admins-card');
  await admins.getByLabel('Email de Google').fill('Nuevo@x.com');
  await admins.getByRole('button', { name: 'Nombrar admin' }).click();
  await expect(admins.getByText('nuevo@x.com')).toBeVisible();
  await expect(admins.getByText('Pendiente')).toBeVisible();
  await admins.getByRole('button', { name: 'Hacer admin a Caro' }).click();
  await expect(admins.getByRole('button', { name: 'Hacer admin a Caro' })).toHaveCount(0);
  await reader.goto('/seasons');
  await expect(reader.getByRole('button', { name: '+ Nueva temporada' })).toBeVisible();
  await context2.close();

  const token = await apiLogin(page, 'test:nuevo:nuevo@x.com:Nuevo');
  const me = await page.request.get(`${API}/me`, { headers: { authorization: `Bearer ${token}` } });
  expect((await me.json()).user.role).toBe('admin');
});

test('accesibilidad y responsive en cada vista, en ambos temas', async ({ page }) => {
  await login(page, 'Master', 'master');
  await createGroup(page);
  await importBackup(page);
  await seedBalances(page);

  const seasons = await page.request.get(`${API}/groups`, {
    headers: { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('pc_token'))}` },
  });
  expect(seasons.ok()).toBe(true);

  const check = (where: string) => checkPage(page, where);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/seasons');
    await check('temporadas');
    await page.getByRole('link', { name: 'Ver partidas' }).click();
    await expect(page.getByRole('heading', { name: 'Importada' })).toBeVisible();
    await check('partidas');
    await page.getByRole('link', { name: /Noche dos/ }).click();
    await expect(page.getByTestId('pot')).toBeVisible();
    await check('partida');
    await page.locator('main').getByRole('link', { name: /Saldos$/ }).click();
    await expect(page.getByRole('heading', { name: 'Saldos de la partida' })).toBeVisible();
    await check('saldos de partida');
    await page.goto('/players');
    await expect(page.getByText('Ana')).toBeVisible();
    await check('jugadores');
    await page.getByRole('link', { name: 'Estadísticas de Ana' }).click();
    await expect(page.getByTestId('hero-balance')).toBeVisible();
    await expect(page.getByRole('img', { name: /Balance por partida/ })).toBeVisible();
    await check('stats');
    await page.goto('/ranking');
    await expect(page.locator('.podium')).toBeVisible();
    await check('ranking');
    await page.goto('/debts');
    await expect(page.getByTestId('balance-Beto')).toBeVisible();
    await check('saldos');
    await page.goto('/settings');
    await expect(page.getByTestId('settings-invite')).toBeVisible();
    await check('configuración');
  }
});

test('mesa online: sala de espera, iniciar, jugar una mano y cerrar', async ({ page, browser, isMobile }) => {
  await login(page, 'Seba');
  const code = await createGroup(page);
  await nav(page, 'Mesa');
  // Un administrador entra a la mesa sin jugador; si quiere jugar, elige su nick.
  await page.getByText('Quiero jugar yo también').click();
  await page.getByLabel('Tu nick').fill('Seba');
  await page.getByRole('button', { name: 'Crear mi jugador' }).click();
  await expect(page.getByRole('heading', { name: 'Mesa', exact: true })).toBeVisible();
  await expect(page.getByText('Todavía no hay nadie sentado.').or(page.getByText('Seba (vos)'))).toBeVisible();
  await expect(page.getByRole('button', { name: /Iniciar partida/ })).toBeDisabled();

  // Un miembro de solo lectura también se sienta.
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await login(page2, 'Nico', 'reader');
  await page2.goto('/');
  await page2.getByLabel('Código de invitación').fill(code);
  await page2.getByRole('button', { name: 'Unirme' }).click();
  await page2.getByLabel('Tu nick').fill('Nico');
  await page2.getByRole('button', { name: 'Crear mi jugador' }).click();
  await nav(page2, 'Mesa');
  await expect(page2.getByText('Nico (vos)')).toBeVisible();

  await expect(page.getByText('Nico', { exact: true }).first()).toBeVisible({ timeout: 10000 });
  await checkPage(page, 'mesa: sala de espera');
  const start = page.getByRole('button', { name: /Iniciar partida \(2 jugadores\)/ });
  await expect(start).toBeEnabled();
  await start.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();

  // Los dos ven la mano; solo cada uno ve sus cartas.
  await expect(page.getByTestId('felt')).toBeVisible();
  await expect(page.getByTestId('pot')).toHaveText('Pozo $30');
  // Cuenta regresiva del turno y conexión en vivo.
  await expect(page.getByTestId('turn-timer')).toContainText(/\d:\d\d/);
  // Ciegas de la mano y cuándo suben (por defecto se duplican cada 15 minutos).
  await expect(page.getByTestId('blinds')).toContainText('Ciegas $10/$20');
  await expect(page.getByTestId('blinds-note')).toContainText(/Suben a \$20\/\$40 en 1[45]:\d\d/);
  await expect(page.getByRole('img', { name: 'En vivo' })).toBeVisible({ timeout: 10000 });
  // Mazo de 4 colores por defecto: tréboles verdes y diamantes azules, para no confundirlos con picas y corazones.
  await expect(page.locator('.table-layout')).toHaveClass(/deck-four/);
  // Tus cartas van en tu asiento, sobre el paño.
  await expect(page.getByTestId('felt').getByTestId('my-hand').getByRole('img')).toHaveCount(2);
  // En el celular la mesa reemplaza al menú de abajo; se vuelve con la flecha.
  if (isMobile) {
    await expect(page.getByRole('navigation', { name: 'Principal móvil' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Volver al menú' })).toBeVisible();
  }
  await expect(page2.getByTestId('my-hand').getByRole('img')).toHaveCount(2, { timeout: 10000 });
  await expect(page.getByRole('img', { name: 'Carta oculta' })).toHaveCount(0);
  await checkPage(page, 'mesa: partida');
  await checkPage(page2, 'mesa: partida (lector)');

  // Quien tiene el turno se retira: la mano termina y el otro cobra.
  const actor = (await page.getByRole('button', { name: 'Retirarme' }).count()) > 0 ? page : page2;
  const other = actor === page ? page2 : page;
  // Quien piensa se ve agrandado para los demás; en su propia pantalla no.
  const thinking = actor === page ? 'Seba' : 'Nico';
  await expect(other.getByTestId(`seat-${thinking}`)).toHaveClass(/pseat-thinking/);
  await expect(actor.getByTestId(`seat-${thinking}`)).not.toHaveClass(/pseat-thinking/);
  await actor.getByRole('button', { name: 'Retirarme' }).click();
  await expect(actor.getByTestId('last-action')).toContainText('te retiraste');
  // El polling con el socket en vivo es de 15 s: ver el cambio antes prueba que llegó por WebSocket.
  await expect(other.getByTestId('last-action')).toContainText('se retiró', { timeout: 5000 });
  await expect(page.getByRole('status').filter({ hasText: 'ganó' }).or(page.getByRole('status').filter({ hasText: 'ganaste' }))).toBeVisible({ timeout: 10000 });
  await checkPage(page, 'mesa: fin de mano');

  // Cierre: se genera la partida con su deuda.
  await page.getByRole('button', { name: 'Cerrar partida' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar partida' }).click();
  await expect(page.getByRole('link', { name: 'Ver resultados y saldos' })).toBeVisible();
  await page.getByRole('link', { name: 'Ver resultados y saldos' }).click();
  await expect(page.getByText('✓ Partida cerrada')).toBeVisible();
  await context2.close();
});

test('mesa online: al agotarse el tiempo el servidor juega por quien no responde', async ({ page, browser }) => {
  test.setTimeout(60000);
  await login(page, 'Seba');
  const code = await createGroup(page);
  await nav(page, 'Mesa');
  await page.getByText('Quiero jugar yo también').click();
  await page.getByLabel('Tu nick').fill('Seba');
  await page.getByRole('button', { name: 'Crear mi jugador' }).click();

  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await login(page2, 'Nico', 'reader');
  await page2.goto('/');
  await page2.getByLabel('Código de invitación').fill(code);
  await page2.getByRole('button', { name: 'Unirme' }).click();
  await page2.getByLabel('Tu nick').fill('Nico');
  await page2.getByRole('button', { name: 'Crear mi jugador' }).click();
  await nav(page2, 'Mesa');
  await expect(page2.getByText('Nico (vos)')).toBeVisible();

  const start = page.getByRole('button', { name: /Iniciar partida \(2 jugadores\)/ });
  await expect(start).toBeEnabled({ timeout: 10000 });
  await start.click();
  await page.getByLabel('Tiempo por turno (segundos, 0 = sin límite)').fill('5');
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();
  await expect(page.getByRole('alert')).toContainText('entre 10 y 300');
  await page.getByLabel('Tiempo por turno (segundos, 0 = sin límite)').fill('10');
  await page.getByLabel('Duplicar las ciegas cada (minutos, 0 = nunca)').fill('3');
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();
  await expect(page.getByRole('alert')).toContainText('Las ciegas se duplican cada 0');
  await page.getByLabel('Duplicar las ciegas cada (minutos, 0 = nunca)').fill('15');
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();

  await expect(page.getByTestId('turn-timer')).toContainText(/0:(0\d|10)/);
  await expect(page2.getByTestId('turn-timer')).toBeVisible({ timeout: 10000 });
  // Nadie actúa: a los ~10 s el servidor se retira por quien tenía el turno, y ambos lo ven.
  for (const p of [page, page2]) {
    await expect(p.getByTestId('last-action')).toContainText('(tiempo agotado)', { timeout: 25000 });
    await expect(p.getByRole('status').filter({ hasText: /ganó|ganaste/ })).toBeVisible();
  }
  await context2.close();
});

test('mesa online: un administrador agrega jugadores sin usuario y juega por ellos', async ({ page }) => {
  await login(page, 'Seba');
  await createGroup(page);
  await nav(page, 'Jugadores');
  await addPlayer(page, 'Ana');
  await addPlayer(page, 'Beto');

  // Sin jugador propio igual entra a la mesa: no se le pide elegir un nick.
  await nav(page, 'Mesa');
  await expect(page.getByRole('heading', { name: 'Administrar mesa' })).toBeVisible();
  await expect(page.getByLabel('Tu nick')).toBeHidden(); // la elección de nick queda plegada
  await expect(page.getByRole('button', { name: /Iniciar partida/ })).toBeDisabled();

  await page.getByRole('button', { name: '+ Agregar jugador' }).click();
  await page.getByRole('button', { name: 'Agregar a Ana' }).click();
  await page.getByRole('button', { name: 'Agregar a Beto' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.getByTestId('admin-seat-Ana')).toContainText('lo jugás vos');
  await checkPage(page, 'mesa: administrar (espera)');

  const start = page.getByRole('button', { name: /Iniciar partida \(2 jugadores\)/ });
  await expect(start).toBeEnabled();
  await start.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();

  // Ve las cartas de los dos y juega los turnos por ellos.
  await expect(page.getByTestId('felt')).toBeVisible();
  await expect(page.getByTestId('my-hand')).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: 'Te toca jugar por' })).toBeVisible();
  await checkPage(page, 'mesa: administrador jugando por otros');
  await page.getByRole('button', { name: /Igualar|Pasar/ }).click();
  await expect(page.getByTestId('last-action')).toContainText(/igualó|pasó/);
  await page.getByRole('button', { name: 'Retirarme' }).click();
  await expect(page.getByRole('status').filter({ hasText: /ganó/ })).toBeVisible();

  // Reparte y cierra sin estar sentado.
  await page.getByRole('button', { name: 'Cerrar partida' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar partida' }).click();
  await expect(page.getByRole('link', { name: 'Ver resultados y saldos' })).toBeVisible();
});

test('mesa online: al terminar, los jugadores que manejás se muestran juntos y repartir queda a la vista', async ({ page }) => {
  test.setTimeout(60000);
  await login(page, 'Seba');
  await createGroup(page);
  await nav(page, 'Jugadores');
  for (const n of ['Ana', 'Beto', 'Caro', 'Nico']) await addPlayer(page, n);
  await nav(page, 'Mesa');
  await page.getByRole('button', { name: '+ Agregar jugador' }).click();
  for (const n of ['Ana', 'Beto', 'Caro', 'Nico']) await page.getByRole('button', { name: `Agregar a ${n}` }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).click();
  await page.getByRole('button', { name: /Iniciar partida \(4 jugadores\)/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();
  await expect(page.getByTestId('felt')).toBeVisible();

  // Se retiran tres (jugando por ellos): el cuarto gana solo.
  for (let i = 1; i <= 3; i++) {
    await page.getByRole('button', { name: 'Retirarme' }).click();
    await expect(page.locator('.felt .pseat-folded')).toHaveCount(i);
  }
  await expect(page.getByTestId('hand-result').locator('visible=true')).toBeVisible();

  // Los tres retirados van en una sola fila; quien ganó solo, en la suya (puede mostrar una carta).
  const group = page.getByTestId('show-group');
  await expect(group).toContainText('los jugás vos');
  await expect(page.getByRole('button', { name: /^Mostrar cartas de / })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Repartir próxima mano' })).toBeInViewport();
  await checkPage(page, 'mesa: mostrar cartas de varios');

  // Mostrar las de los tres: pasan a verse en sus asientos y la fila desaparece.
  await page.getByRole('button', { name: 'Mostrar las cartas de los jugadores que manejás', exact: true }).click();
  await expect(group).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Mostrar cartas de / })).toHaveCount(1);
  await expect(page.locator('.felt .pseat .pcard:not(.pcard-own)')).toHaveCount(6);
});

test.describe('mesa online: video', () => {
  // Cámara y micrófono falsos del navegador (ver launchOptions en playwright.config.ts).
  test.use({ permissions: ['camera', 'microphone'] });

  test('un jugador transmite, el otro lo ve, y al detener vuelve la inicial', async ({ page, browser }) => {
    test.setTimeout(60000);
    await login(page, 'Seba');
    const code = await createGroup(page);
    await nav(page, 'Mesa');
    await page.getByText('Quiero jugar yo también').click();
    await page.getByLabel('Tu nick').fill('Seba');
    await page.getByRole('button', { name: 'Crear mi jugador' }).click();

    const context2 = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page2 = await context2.newPage();
    await login(page2, 'Nico', 'reader');
    await page2.goto('/');
    await page2.getByLabel('Código de invitación').fill(code);
    await page2.getByRole('button', { name: 'Unirme' }).click();
    await page2.getByLabel('Tu nick').fill('Nico');
    await page2.getByRole('button', { name: 'Crear mi jugador' }).click();
    await nav(page2, 'Mesa');
    await expect(page2.getByText('Nico (vos)')).toBeVisible();

    const start = page.getByRole('button', { name: /Iniciar partida \(2 jugadores\)/ });
    await expect(start).toBeEnabled({ timeout: 10000 });
    await start.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();
    await expect(page.getByTestId('felt')).toBeVisible();
    await expect(page2.getByTestId('felt')).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('img', { name: 'En vivo' })).toBeVisible({ timeout: 10000 });
    await expect(page2.getByRole('img', { name: 'En vivo' })).toBeVisible({ timeout: 10000 });

    // Sin transmitir, nadie tiene video: se ven las iniciales.
    await expect(page2.locator('.pseat-video')).toHaveCount(0);

    // Seba transmite desde el botón de cámara de la barra: se ve a sí mismo y Nico lo recibe por WebRTC (frames reales).
    await page.getByRole('button', { name: 'Video', exact: true }).click();
    await page.getByRole('button', { name: 'Transmitir video' }).click();
    await expect(page.getByRole('button', { name: 'Detener transmisión' })).toBeVisible();
    const seba = page2.getByTestId('seat-Seba').locator('video.pseat-video');
    await expect(seba).toBeVisible({ timeout: 15000 });
    await expect.poll(() => seba.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('seat-Seba').locator('video.pseat-video')).toBeVisible();
    // Audio apagado por defecto: el stream recibido no trae pista de audio.
    expect(await seba.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getAudioTracks().length)).toBe(0);

    // Detener: Nico vuelve a ver la inicial y la cámara de Seba se apaga.
    const sebaTrack = page.evaluate(() => (document.querySelector('video.pseat-video') as HTMLVideoElement).srcObject !== null);
    expect(await sebaTrack).toBe(true);
    await page.getByRole('button', { name: 'Detener transmisión' }).click();
    await expect(page.getByRole('button', { name: 'Transmitir video' })).toBeVisible();
    await expect(page2.locator('.pseat-video')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.pseat-video')).toHaveCount(0);

    // Con micrófono: el otro recibe una pista de audio.
    await page.getByLabel('Micrófono').check();
    await page.getByRole('button', { name: 'Transmitir video' }).click();
    await expect(seba).toBeVisible({ timeout: 15000 });
    await expect.poll(() => seba.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getAudioTracks().length), { timeout: 15000 }).toBe(1);
    await page.getByRole('button', { name: 'Detener transmisión' }).click();
    await expect(page2.locator('.pseat-video')).toHaveCount(0, { timeout: 10000 });
    await context2.close();
  });
});

test('mesa online: sin fichas te reparten pero ves tus cartas solo si recomprás', async ({ page, browser }) => {
  test.setTimeout(90000);
  await login(page, 'Seba');
  const code = await createGroup(page);
  const master = await apiLogin(page, MASTER_TOKEN);
  const gid = (await (await page.request.get(`${API}/groups`, { headers: { authorization: `Bearer ${master}` } })).json())[0].id as string;

  // Tres jugadores (por API, para ir rápido); Seba es administrador y solo reparte.
  const players: { name: string; page: Page; token: string; id: string }[] = [];
  for (const name of ['Nico', 'Pablo', 'Caro']) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const token = await login(p, name, 'reader');
    const auth = { authorization: `Bearer ${token}` };
    await p.request.post(`${API}/groups/join`, { headers: auth, data: { inviteCode: code } });
    const claimed = await p.request.post(`${API}/groups/${gid}/me/player`, { headers: auth, data: { name } });
    players.push({ name, page: p, token, id: (await claimed.json()).id });
    await p.goto('/table');
    await expect(p.getByText(`${name} (vos)`)).toBeVisible();
  }
  const [, pablo] = players;

  await page.goto('/table');
  const start = page.getByRole('button', { name: /Iniciar partida \(3 jugadores\)/ });
  await expect(start).toBeEnabled({ timeout: 15000 });
  await start.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();
  await expect(page.getByTestId('felt')).toBeVisible();

  /** Quien tenga el turno hace `pick`; devuelve cuando `done` se cumple. */
  const play = async (pick: (p: Page) => Promise<boolean>, done: () => Promise<boolean>) => {
    for (let i = 0; i < 40 && !(await done()); i++) {
      for (const pl of players) if (await pick(pl.page)) break;
      await page.waitForTimeout(250);
    }
    expect(await done()).toBe(true);
  };
  const click = async (p: Page, name: RegExp | string) => {
    const b = p.getByRole('button', { name });
    if ((await b.count()) === 0 || !(await b.first().isVisible())) return false;
    await b.first().click();
    return true;
  };

  // Primera mano: todos se retiran y gana quien quede.
  await play(p => click(p, 'Retirarme'), async () => (await page.getByRole('status').filter({ hasText: /ganó|ganaste/ }).count()) > 0);

  // Pablo se queda sin fichas y se reparte otra mano.
  await page.request.post('http://127.0.0.1:3100/e2e/bust', { data: { playerId: pablo.id } });
  await page.getByRole('button', { name: 'Repartir próxima mano' }).click();
  await expect(pablo.page.getByTestId('seat-Pablo')).toContainText('Sin fichas');
  // Le repartieron, pero no ve sus cartas.
  await expect(pablo.page.getByTestId('my-hand')).toHaveCount(0);
  await expect(pablo.page.getByTestId('pending-note')).toContainText('no las ves hasta que recompres');

  // Los demás igualan o pasan hasta que le toca a Pablo: solo puede retirarse (o recomprar).
  await play(
    async p => (p === pablo.page ? false : (await click(p, /^(Igualar|Pasar)/))),
    async () => (await pablo.page.getByRole('button', { name: 'Retirarme' }).count()) > 0,
  );
  await expect(pablo.page.getByRole('button', { name: /^(Igualar|Pasar)/ })).toHaveCount(0);
  await checkPage(pablo.page, 'mesa: sin fichas (pendiente de recompra)');

  // Recompra a tiempo: ve sus cartas y juega.
  await pablo.page.getByLabel('Fichas a recomprar').fill('200');
  await pablo.page.getByRole('button', { name: 'Recomprar' }).click();
  await expect(pablo.page.getByTestId('my-hand').getByRole('img')).toHaveCount(2);
  await expect(pablo.page.getByTestId('pending-note')).toHaveCount(0);
  await expect(pablo.page.getByRole('button', { name: /^Igualar/ })).toBeVisible();
  await expect(pablo.page.getByTestId('seat-Pablo')).not.toContainText('Sin fichas');
});

/** Animación Lottie mínima (un círculo): el e2e no depende del CDN de Google. */
const TINY_LOTTIE = JSON.stringify({
  v: '5.7.0', fr: 30, ip: 0, op: 60, w: 100, h: 100, nm: 't', ddd: 0, assets: [],
  layers: [{
    ddd: 0, ind: 1, ty: 4, nm: 's', sr: 1, ao: 0, ip: 0, op: 60, st: 0,
    ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [50, 50, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [{ ty: 'gr', nm: 'g', it: [
      { ty: 'el', nm: 'e', d: 1, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [60, 60] } },
      { ty: 'fl', nm: 'f', c: { a: 0, k: [1, 0.8, 0.2, 1] }, o: { a: 0, k: 100 }, r: 1 },
      { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } },
    ] }],
  }],
});

test('mesa online: emojis animados desde el botón flotante, estés sentado o no', async ({ page, browser }) => {
  test.setTimeout(90000);
  const fakeCdn = (ctx: import('@playwright/test').BrowserContext) => ctx.route('https://fonts.gstatic.com/**', route => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: TINY_LOTTIE,
  }));
  await fakeCdn(page.context());
  await login(page, 'Seba');
  const code = await createGroup(page);
  const master = await apiLogin(page, MASTER_TOKEN);
  const gid = (await (await page.request.get(`${API}/groups`, { headers: { authorization: `Bearer ${master}` } })).json())[0].id as string;

  // Dos jugadores (por API, para ir rápido); Seba es administrador y solo mira.
  const players: { name: string; page: Page; id: string }[] = [];
  for (const name of ['Nico', 'Pablo']) {
    const ctx = await browser.newContext();
    await fakeCdn(ctx);
    const p = await ctx.newPage();
    const token = await login(p, name, 'reader');
    const auth = { authorization: `Bearer ${token}` };
    await p.request.post(`${API}/groups/join`, { headers: auth, data: { inviteCode: code } });
    const claimed = await p.request.post(`${API}/groups/${gid}/me/player`, { headers: auth, data: { name } });
    players.push({ name, page: p, id: (await claimed.json()).id });
    await p.goto('/table');
    await expect(p.getByText(`${name} (vos)`)).toBeVisible();
  }
  const [nico, pablo] = players;
  await page.goto('/table');
  await expect(page.getByText('Pablo', { exact: true }).first()).toBeVisible({ timeout: 15000 });

  const fab = (p: Page) => p.getByRole('button', { name: 'Enviar un emoji' });
  const send = async (p: Page, label: string) => {
    await fab(p).click();
    await p.getByRole('group', { name: 'Emojis' }).getByRole('button', { name: label }).click();
  };

  // Sala de espera (nadie está en la mano): el botón flota sobre la página y cualquiera lo ve, sentado o no.
  await fab(nico.page).click();
  await checkPage(nico.page, 'mesa: paleta de emojis');
  await nico.page.getByRole('group', { name: 'Emojis' }).getByRole('button', { name: 'Risa' }).click();
  for (const p of [nico.page, pablo.page, page]) {
    await expect(p.getByTestId('emoji-float')).toContainText('Nico');
    await expect(p.getByTestId('emoji-said')).toHaveText('Nico envió Risa');
  }
  // La animación se descarga y reemplaza al emoji común.
  await expect(page.locator('.emoji-lottie svg').first()).toBeAttached({ timeout: 10000 });
  // El botón descansa lo que el servidor deja pasar.
  await expect(fab(nico.page)).toBeDisabled();
  await expect(fab(nico.page)).toBeEnabled({ timeout: 4000 });

  // Ya en la mesa, el botón está en el paño y el emoji sale desde el asiento de quien lo manda.
  await page.getByRole('button', { name: /Iniciar partida \(2 jugadores\)/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();
  await expect(pablo.page.getByTestId('felt')).toBeVisible();
  await expect(pablo.page.locator('.emoji-fab-felt')).toBeVisible();
  await send(nico.page, 'Fuego');
  const floating = pablo.page.getByTestId('emoji-float').last();
  await expect(floating).toContainText('Nico');
  const seat = await pablo.page.locator(`[data-player="${nico.id}"]`).boundingBox();
  const at = await floating.boundingBox();
  expect(Math.abs(at!.x + at!.width / 2 - (seat!.x + seat!.width / 2))).toBeLessThan(70);
  await checkPage(pablo.page, 'mesa: emoji en el paño');

  // El administrador que solo mira también puede mandar, y los jugadores lo ven con su nombre.
  await expect(fab(page)).toBeEnabled({ timeout: 4000 });
  await send(page, 'Aplausos');
  await expect(pablo.page.getByTestId('emoji-said')).toHaveText('Seba envió Aplausos');

  // Silenciar: se oculta el botón y no se ven los de los demás.
  await pablo.page.getByRole('button', { name: 'Preferencias de la mesa' }).first().click();
  await pablo.page.getByRole('switch', { name: /Emojis/ }).uncheck();
  await pablo.page.getByRole('button', { name: 'Listo' }).click();
  await expect(fab(pablo.page)).toHaveCount(0);
  await expect(fab(nico.page)).toBeEnabled({ timeout: 4000 });
  await send(nico.page, 'Bien');
  await expect(page.getByTestId('emoji-said')).toHaveText('Nico envió Bien');
  await expect(pablo.page.getByTestId('emoji-float')).toHaveCount(0);
});
