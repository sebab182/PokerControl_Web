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
  await expect(page.getByRole('dialog')).toContainText('El pozo no cuadra: faltan $21');
  await page.getByRole('button', { name: 'Cerrar de todas formas' }).click();

  // Deudas: Ana +29,50, Beto -50,50.
  await expect(page.getByRole('heading', { name: 'Deudas de la partida' })).toBeVisible();
  await page.getByRole('button', { name: '+ Registrar pago' }).click();
  const pending = page.getByRole('dialog');
  await pending.getByLabel('Monto que paga ahora').fill('10');
  await pending.getByLabel('Nota (opcional)').fill('efectivo');
  await pending.getByRole('button', { name: 'Pago parcial' }).click();
  await expect(page.getByText('Parcial')).toBeVisible();
  await expect(page.getByText('efectivo')).toBeVisible();
  await page.getByRole('button', { name: '+ Registrar pago' }).click();
  await page.getByRole('button', { name: 'Saldó todo' }).click();
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Saldada')).toBeVisible();

  // Partida cerrada: sin edición.
  await page.getByRole('link', { name: '← Partida' }).click();
  await expect(page.getByText('✓ Partida cerrada')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ Compra' })).toHaveCount(0);

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

test('importar backup, reorganizar y deshacer; bloqueo por pago', async ({ page }) => {
  await login(page, 'Seba');
  await createGroup(page);
  await importBackup(page);

  await nav(page, 'Temporadas');
  await expect(page.getByRole('heading', { name: 'Importada' })).toBeVisible();

  await nav(page, 'Deudas');
  await expect(page.getByTestId('debtor-Beto')).toContainText('$80');
  await page.getByRole('button', { name: 'Reorganizar deudas' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reorganizar' }).click();
  await expect(page.getByText('Deuda consolidada')).toBeVisible();

  await page.getByRole('button', { name: 'Deshacer reorganización' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Deshacer' }).click();
  await expect(page.getByText('Vieja A')).toBeVisible();

  await page.getByRole('button', { name: 'Reorganizar deudas' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reorganizar' }).click();
  await expect(page.getByText('Deuda consolidada')).toBeVisible();
  await page.getByRole('button', { name: '+ Registrar pago' }).click();
  await page.getByLabel('Monto que paga ahora').fill('5');
  await page.getByRole('button', { name: 'Pago parcial' }).click();
  await expect(page.getByRole('button', { name: /bloqueado por pagos/ })).toBeDisabled();
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
  await nav(reader, 'Deudas');
  await expect(reader.getByTestId('debtor-Beto')).toBeVisible();
  await expect(reader.getByRole('button', { name: '+ Registrar pago' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: /Reorganizar/ })).toHaveCount(0);
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
    await page.locator('main').getByRole('link', { name: /Deudas$/ }).click();
    await expect(page.getByRole('heading', { name: 'Deudas de la partida' })).toBeVisible();
    await check('deudas de partida');
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
    await expect(page.getByTestId('debtor-Beto')).toBeVisible();
    await check('deudas');
    await page.goto('/settings');
    await expect(page.getByTestId('settings-invite')).toBeVisible();
    await check('configuración');
  }
});

test('mesa online: sala de espera, iniciar, jugar una mano y cerrar', async ({ page, browser }) => {
  await login(page, 'Seba');
  const code = await createGroup(page);
  await nav(page, 'Mesa');
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

  await expect(page.getByText('Nico', { exact: true })).toBeVisible({ timeout: 10000 });
  await checkPage(page, 'mesa: sala de espera');
  const start = page.getByRole('button', { name: /Iniciar partida \(2 jugadores\)/ });
  await expect(start).toBeEnabled();
  await start.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Iniciar partida' }).click();

  // Los dos ven la mano; solo cada uno ve sus cartas.
  await expect(page.getByTestId('felt')).toBeVisible();
  await expect(page.getByTestId('pot')).toHaveText('Pozo $30');
  await expect(page.getByTestId('my-hand').getByRole('img')).toHaveCount(2);
  await expect(page2.getByTestId('my-hand').getByRole('img')).toHaveCount(2, { timeout: 10000 });
  await expect(page.getByRole('img', { name: 'Carta oculta' })).toHaveCount(0);
  await checkPage(page, 'mesa: partida');
  await checkPage(page2, 'mesa: partida (lector)');

  // Quien tiene el turno se retira: la mano termina y el otro cobra.
  const actor = (await page.getByRole('button', { name: 'Retirarme' }).count()) > 0 ? page : page2;
  await actor.getByRole('button', { name: 'Retirarme' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ganó' }).or(page.getByRole('status').filter({ hasText: 'ganaste' }))).toBeVisible({ timeout: 10000 });
  await checkPage(page, 'mesa: fin de mano');

  // Cierre: se genera la partida con su deuda.
  await page.getByRole('button', { name: 'Cerrar partida' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar partida' }).click();
  await expect(page.getByRole('link', { name: 'Ver resultados y deudas' })).toBeVisible();
  await page.getByRole('link', { name: 'Ver resultados y deudas' }).click();
  await expect(page.getByText('✓ Partida cerrada')).toBeVisible();
  await context2.close();
});
