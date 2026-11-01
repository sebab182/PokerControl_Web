import { randomUUID } from 'node:crypto';
import { AuthResponse, ErrorResponse, GoogleLoginBody, MeResponse, TokenResponse } from '@pokercontrol/contracts';
import type { Static } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError } from '../errors';
import type { Conn } from '../repo';

export async function userGroups(db: Conn, userId: string) {
  return db.select({ id: schema.groups.id, name: schema.groups.name })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(eq(schema.groupMembers.userId, userId))
    .orderBy(schema.groupMembers.joinedAt);
}

const toUser = (u: typeof schema.users.$inferSelect) => ({
  id: u.id, name: u.name, email: u.email, pictureUrl: u.pictureUrl,
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
    const [user] = await app.db.insert(schema.users).values({
      id: randomUUID(),
      googleSub: identity.sub,
      email: identity.email,
      name: identity.name,
      pictureUrl: identity.picture,
    }).onConflictDoUpdate({
      target: schema.users.googleSub,
      set: { email: identity.email, name: identity.name, pictureUrl: identity.picture },
    }).returning();
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
