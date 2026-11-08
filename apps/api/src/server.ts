import { buildApp } from './app';
import { connect } from './db/client';
import { backfillHandHistory, backfillHandInsights } from './hand-history';
import { purgeStaleRooms } from './routes/live';

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
// Completa el historial de las manos anteriores a este detalle (idempotente; si falla, la API arranca igual).
await backfillHandHistory(db)
  .then(n => { if (n > 0) app.log.info(`Historial de manos reconstruido: ${n} manos`); })
  .catch(e => app.log.error(e, 'No se pudo reconstruir el historial de manos'));
await backfillHandInsights(db)
  .then(n => { if (n > 0) app.log.info(`Análisis de manos completado: ${n} manos`); })
  .catch(e => app.log.error(e, 'No se pudo completar el análisis de las manos'));
await purgeStaleRooms(db).catch(e => app.log.error(e, 'No se pudieron limpiar las salas remotas viejas'));
await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
