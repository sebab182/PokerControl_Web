import { expect, test, type Page } from '@playwright/test';

// El «celular» filma dos cartas quietas (e2e/fixtures/cards.mjpeg): no hay que tocar nada para que salgan.
// Va en su propio archivo porque el video falso se elige al lanzar el navegador (no se puede cambiar dentro de un describe).
test.use({
  permissions: ['camera', 'microphone'],
  launchOptions: {
    ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-video-capture=e2e/fixtures/cards.mjpeg',
      ...(process.env.PW_CHROMIUM ? ['--no-sandbox'] : [])],
  },
});

const API = 'http://127.0.0.1:3100/api/v1';
const MASTER_TOKEN = 'test:e2e-master:master@x.com:Master';
let userSeq = 0;

test.beforeEach(async ({ request }) => {
  await request.post('http://127.0.0.1:3100/e2e/reset');
});

async function apiLogin(page: Page, idToken: string): Promise<string> {
  const res = await page.request.post(`${API}/auth/google`, { data: { idToken } });
  return (await res.json()).token;
}

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

async function createGroup(page: Page, name = 'Los viernes'): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Nombre del grupo').fill(name);
  await page.getByRole('button', { name: 'Crear grupo' }).click();
  const code = await page.getByTestId('invite-code').innerText();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Ranking', exact: true })).toBeVisible();
  return code;
}

test('las cartas que se filman salen solas, recortadas, a quien corresponde', async ({ page, browser }) => {
  test.setTimeout(120000);
  const hostToken = await login(page, 'Seba');
  const code = await createGroup(page);
  const auth = { authorization: `Bearer ${hostToken}` };
  const context2 = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page2 = await context2.newPage();
  await login(page2, 'Nico', 'reader');
  await page2.goto('/');
  await page2.getByLabel('Código de invitación').fill(code);
  await page2.getByRole('button', { name: 'Unirme' }).click();
  await page2.getByLabel('Tu nick').fill('Nico');
  await page2.getByRole('button', { name: 'Crear mi jugador' }).click();
  const groupId = (await (await page.request.get(`${API}/groups`, { headers: auth })).json())[0].id;
  const ana = (await (await page.request.post(`${API}/groups/${groupId}/players`, { headers: auth, data: { name: 'Ana' } })).json()).id;
  const nico = (await (await page.request.get(`${API}/groups/${groupId}/players`, { headers: auth })).json()).find((p: { name: string }) => p.name === 'Nico').id;
  const season = (await (await page.request.get(`${API}/groups/${groupId}/seasons`, { headers: auth })).json())[0].id;
  const session = await (await page.request.post(`${API}/groups/${groupId}/seasons/${season}/sessions`, {
    headers: { ...auth, 'idempotency-key': `e2e-auto-${Date.now()}` }, data: { playerIds: [ana, nico], initialBuyIn: 100 },
  })).json();
  await page2.goto(`/sessions/${session.id}`);
  await page2.getByTestId('live-enter').click();
  await page2.getByRole('button', { name: /Juego a distancia/ }).click();
  await expect(page2.getByRole('heading', { name: /^Jugás a distancia · / })).toBeVisible();
  await page.goto(`/sessions/${session.id}`);
  await page.getByTestId('live-enter').click();
  await page.getByRole('button', { name: /Estoy en la mesa/ }).first().click();
  await expect(page.getByRole('heading', { name: /^En la mesa · / })).toBeVisible();

  // Se abre la cámara y no se toca nada más: las dos cartas quietas salen como «Cartas de Nico».
  await page.getByTestId('open-shot').click();
  await expect(page.getByTestId('shot-status')).toHaveText('Enviado: Cartas de Nico ✓', { timeout: 30000 });
  await expect(page2.getByRole('button', { name: 'Ver mis cartas' })).toBeVisible({ timeout: 15000 });
  await page2.getByRole('button', { name: 'Ver mis cartas' }).click();
  const mine = page2.getByRole('img', { name: 'Tus cartas' });
  await expect(mine).toBeVisible();
  // La imagen recibida son las dos cartas lado a lado (más ancha que alta), no el cuadro entero.
  const size = await mine.evaluate((i: HTMLImageElement) => ({ w: i.naturalWidth, h: i.naturalHeight }));
  expect(size.w / size.h).toBeGreaterThan(1.3);
  expect(size.w / size.h).toBeLessThan(1.6);
  // Esas dos cartas ya se enviaron: el flop espera tres nuevas y no manda nada con lo que sigue a la vista.
  await expect(page.getByTestId('shot-button')).toContainText('Flop');
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('shot-status')).not.toHaveText('Enviado: Flop ✓');
  await expect(page2.getByTestId('slot-flop').getByRole('img')).toBeHidden();
  await context2.close();
});
