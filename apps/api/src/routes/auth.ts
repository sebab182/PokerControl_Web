import { randomUUID } from 'node:crypto';
import { AuthResponse, ErrorResponse, GoogleLoginBody, MeResponse, TokenResponse } from '@pokercontrol/contracts';
import type { Static } from '@sinclair/typebox';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError } from '../errors';
import type { Conn } from '../repo';

export type Role = typeof schema.users.$inferSelect.role;

/** Clave arbitraria y fija de pg_advisory_xact_lock para serializar los logins. */
const LOGIN_LOCK = 7264001;

/** Se lee en cada request: quitar un admin rige de inmediato, sin esperar a que venza el JWT. */
export async function userRole(db: Conn, userId: string): Promise<Role | null> {
  const [user] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId));
  return user?.role ?? null;
}

/** Master y admins ven todos los grupos; solo lectura, aquellos donde es miembro. */
export async function userGroups(db: Conn, userId: string) {
  const role = await userRole(db, userId);
  const isEditor = role === 'master' || role === 'admin';
  return db.select({ id: schema.groups.id, name: schema.groups.name, playerId: schema.players.id })
    .from(schema.groups)
    .leftJoin(schema.groupMembers, and(
      eq(schema.groupMembers.groupId, schema.groups.id),
      eq(schema.groupMembers.userId, userId),
    ))
    .leftJoin(schema.players, and(eq(schema.players.groupId, schema.groups.id), eq(schema.players.userId, userId)))
    .where(isEditor ? undefined : isNotNull(schema.groupMembers.userId))
    .orderBy(sql`coalesce(${schema.groupMembers.joinedAt}, ${schema.groups.createdAt})`, schema.groups.id);
}

const toUser = (u: typeof schema.users.$inferSelect) => ({
  id: u.id, name: u.name, email: u.email, pictureUrl: u.pictureUrl, role: u.role,
});

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: Static<typeof GoogleLoginBody> }>('/auth/google', {
    config: { rateLimit: { max: app.rateLimitMax * 3, timeWindow: '1 minute' } },
    schema: {
      tags: ['auth'], security: [], body: GoogleLoginBody,
      response: { 200: AuthResponse, '4xx': ErrorResponse },
    },
  }, async req => {
    const identity = await app.verifier(req.body.idToken);
    if (!identity.emailVerified) {
      throw new ApiError(403, 'email_not_verified', 'Tu cuenta de Google no tiene el email verificado.');
    }
    const user = await app.db.transaction(async tx => {
      // Dos primeros logins simultáneos no pueden competir por ser master.
      await tx.execute(sql`select pg_advisory_xact_lock(${LOGIN_LOCK})`);
      const [row] = await tx.insert(schema.users).values({
        id: randomUUID(),
        googleSub: identity.sub,
        email: identity.email,
        name: identity.name,
        pictureUrl: identity.picture,
      }).onConflictDoUpdate({
        target: schema.users.googleSub,
        set: { email: identity.email, name: identity.name, pictureUrl: identity.picture },
      }).returning();
      if (row.role !== 'reader') return row;

      const [master] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, 'master'));
      const grants = await tx.delete(schema.adminGrants)
        .where(eq(schema.adminGrants.email, identity.email.toLowerCase())).returning();
      const role = !master ? 'master' : grants.length > 0 ? 'admin' : null;
      if (!role) return row;
      const [promoted] = await tx.update(schema.users).set({ role }).where(eq(schema.users.id, row.id)).returning();
      return promoted;
    });
    return {
      token: app.jwt.sign({ sub: user.id }),
      user: toUser(user),
      groups: await userGroups(app.db, user.id),
    };
  });

  const verified = async (req: { jwtVerify: () => Promise<unknown> }) => {
    try {
      await req.jwtVerify();
    } catch {
      throw new ApiError(401, 'unauthorized', 'Sesión inválida o vencida.');
    }
  };

  app.post('/auth/refresh', {
    onRequest: verified,
    schema: { tags: ['auth'], response: { 200: TokenResponse, '4xx': ErrorResponse } },
  }, async req => ({ token: app.jwt.sign({ sub: req.user.sub }) }));

  app.get('/me', {
    onRequest: verified,
    schema: { tags: ['auth'], response: { 200: MeResponse, '4xx': ErrorResponse } },
  }, async req => {
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, req.user.sub));
    if (!user) throw new ApiError(401, 'unauthorized', 'Sesión inválida o vencida.');
    return { user: toUser(user), groups: await userGroups(app.db, user.id) };
  });
}
