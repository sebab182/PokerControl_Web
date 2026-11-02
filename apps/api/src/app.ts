import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Ok } from '@pokercontrol/contracts';
import Fastify, { type FastifyError } from 'fastify';
import { googleVerifier, type GoogleVerifier } from './auth';
import { ApiError } from './errors';
import type { Db } from './repo';
import { authRoutes } from './routes/auth';
import { backupRoutes } from './routes/backup';
import { debtRoutes } from './routes/debts';
import { adminRoutes } from './routes/admin';
import type { Role } from './routes/auth';
import { groupRoutes, requireEditor, requireMembership } from './routes/groups';
import { claimPlayerRoutes, playerRoutes } from './routes/players';
import { seasonRoutes } from './routes/seasons';
import { sessionRoutes } from './routes/sessions';

export interface AppOptions {
  db: Db;
  jwtSecret: string;
  jwtExpiresIn?: string;
  corsOrigins?: string[];
  verifier?: GoogleVerifier;
  googleClientIds?: string[];
  logger?: boolean;
  rateLimitMax?: number;
  trustProxy?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    verifier: GoogleVerifier;
    rateLimitMax: number;
  }
  interface FastifyRequest {
    group: { id: string; timezone: string };
    role: Role;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array' } },
  });

  app.decorate('db', options.db);
  app.decorate('verifier', options.verifier ?? googleVerifier(options.googleClientIds ?? []));
  app.decorate('rateLimitMax', options.rateLimitMax ?? 10);
  app.decorateRequest('group', null as unknown as { id: string; timezone: string });
  app.decorateRequest('role', 'reader' as Role);

  // La API solo sirve JSON y Swagger UI: la CSP no aplica y rompería /docs.
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: options.corsOrigins ?? false,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  await app.register(jwt, {
    secret: options.jwtSecret,
    sign: { expiresIn: options.jwtExpiresIn ?? '30d', algorithm: 'HS256' },
    verify: { algorithms: ['HS256'] },
  });
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      info: { title: 'PokerControl API', version: '1.0.0' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
      security: [{ bearerAuth: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error: FastifyError | ApiError, _req, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message, ...error.extra });
    }
    if (error.validation) {
      return reply.status(400).send({ error: 'validation_error', message: error.message });
    }
    if (error.statusCode === 429) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Demasiados intentos. Probá en un minuto.' });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.status(error.statusCode).send({ error: 'bad_request', message: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'internal_error', message: 'Error interno del servidor.' });
  });

  app.get('/health', { schema: { security: [], response: { 200: Ok } } }, async () => ({ ok: true }));

  await app.register(async v1 => {
    await v1.register(authRoutes);
    await v1.register(async authed => {
      authed.addHook('onRequest', async req => {
        try {
          await req.jwtVerify();
        } catch {
          throw new ApiError(401, 'unauthorized', 'Sesión inválida o vencida.');
        }
      });
      await authed.register(adminRoutes);
      await authed.register(groupRoutes);
      await authed.register(async scoped => {
        // preValidation: una request sin permiso recibe 403 aunque el cuerpo sea inválido.
        scoped.addHook('preValidation', requireMembership);
        // Lo único que solo lectura escribe dentro de un grupo: elegir su propio jugador.
        await scoped.register(claimPlayerRoutes);
        await scoped.register(async guarded => {
          guarded.addHook('preValidation', async req => {
            if (req.method !== 'GET') await requireEditor(req);
          });
          await guarded.register(playerRoutes);
          await guarded.register(seasonRoutes);
          await guarded.register(sessionRoutes);
          await guarded.register(debtRoutes);
          await guarded.register(backupRoutes);
        });
      }, { prefix: '/groups/:groupId' });
    });
  }, { prefix: '/api/v1' });

  return app;
}
