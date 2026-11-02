/**
 * Servidor SOLO para Playwright: reemplaza a Google por un verificador de test.
 * No lo importa server.ts y se niega a arrancar en producción o sin base de test.
 * Token: "test:<sub>:<email>:<nombre>".
 */

import { buildApp } from './app';
import { connect, runMigrations } from './db/client';

const url = process.env.TEST_DATABASE_URL;
if (process.env.NODE_ENV === 'production' || !url) {
  throw new Error('El servidor E2E solo corre fuera de producción y con TEST_DATABASE_URL.');
}

await runMigrations(url);
const { db, pool } = connect(url);

/** Cada test arranca sin grupos: master y admins ven todos los de la base. */
async function reset(): Promise<void> {
  await pool.query('TRUNCATE users, groups CASCADE');
  await pool.query(
    `insert into users (id, google_sub, email, name, role) values ('e2e-master', 'e2e-master', 'master@x.com', 'Master', 'master')`,
  );
}
await reset();

const app = await buildApp({
  db,
  jwtSecret: 'e2e-secret-solo-para-pruebas-locales',
  corsOrigins: ['http://localhost:5174'],
  rateLimitMax: 1000,
  verifier: async idToken => {
    const [, sub, email, name] = idToken.split(':');
    return { sub, email, name, emailVerified: true, picture: null };
  },
});
app.post('/e2e/reset', async () => {
  await reset();
  return { ok: true };
});
await app.listen({ port: 3100, host: '127.0.0.1' });
