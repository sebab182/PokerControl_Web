import { buildApp } from './app';
import { connect } from './db/client';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

const list = (value: string | undefined) => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);

const { db } = connect(required('DATABASE_URL'));
const app = await buildApp({
  db,
  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN,
  corsOrigins: list(process.env.CORS_ORIGIN),
  googleClientIds: [...list(process.env.GOOGLE_WEB_CLIENT_ID), ...list(process.env.GOOGLE_ANDROID_CLIENT_ID)],
  logger: true,
  // Detrás del proxy de Render: sin esto, todos los usuarios comparten el rate limit.
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Vence los turnos de la mesa online (lee los vencimientos de la base).
  turnSweepMs: 1000,
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
