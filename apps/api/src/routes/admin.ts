import { AdminEmailParams, AdminOverview, ErrorResponse, GrantAdminBody } from '@pokercontrol/contracts';
import type { Static } from '@sinclair/typebox';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import type { Conn } from '../repo';
import { userRole } from './auth';

const sameEmail = (email: string) => sql`lower(${schema.users.email}) = ${email}`;

async function requireMaster(req: FastifyRequest): Promise<void> {
  if (await userRole(req.server.db, req.user.sub) !== 'master') {
    throw new ApiError(403, 'not_master', 'Solo el usuario master puede administrar roles.');
  }
}

async function overview(db: Conn) {
  const users = await db.select({
    id: schema.users.id, name: schema.users.name, email: schema.users.email, role: schema.users.role,
  }).from(schema.users).orderBy(asc(schema.users.createdAt), asc(schema.users.id));
  const pending = await db.select({ email: schema.adminGrants.email, createdAt: schema.adminGrants.createdAt })
    .from(schema.adminGrants).orderBy(asc(schema.adminGrants.createdAt));
  return { users, pending: pending.map(p => ({ email: p.email, createdAt: p.createdAt.toISOString() })) };
}

export async function adminRoutes(app: FastifyInstance) {
  const scoped = { preHandler: requireMaster };
  const tags = ['admin'];
  const response = { 200: AdminOverview, '4xx': ErrorResponse };

  app.get('/admin/users', { ...scoped, schema: { tags, response } }, async () => overview(app.db));

  app.post<{ Body: Static<typeof GrantAdminBody> }>('/admin/admins', {
    ...scoped,
    schema: { tags, body: GrantAdminBody, response },
  }, async req => app.db.transaction(async tx => {
    const email = req.body.email.trim().toLowerCase();
    const existing = await tx.select({ id: schema.users.id }).from(schema.users).where(sameEmail(email));
    if (existing.length > 0) {
      await tx.update(schema.users).set({ role: 'admin' }).where(and(sameEmail(email), eq(schema.users.role, 'reader')));
    } else {
      await tx.insert(schema.adminGrants).values({ email, grantedBy: req.user.sub }).onConflictDoNothing();
    }
    return overview(tx);
  }));

  app.delete<{ Params: Static<typeof AdminEmailParams> }>('/admin/admins/:email', {
    ...scoped,
    schema: { tags, params: AdminEmailParams, response },
  }, async req => app.db.transaction(async tx => {
    const email = req.params.email.trim().toLowerCase();
    const [master] = await tx.select({ id: schema.users.id }).from(schema.users)
      .where(and(sameEmail(email), eq(schema.users.role, 'master')));
    if (master) throw new ApiError(409, 'cannot_remove_master', 'El master no se puede quitar.');
    const demoted = await tx.update(schema.users).set({ role: 'reader' })
      .where(and(sameEmail(email), eq(schema.users.role, 'admin'))).returning({ id: schema.users.id });
    const revoked = await tx.delete(schema.adminGrants).where(eq(schema.adminGrants.email, email))
      .returning({ email: schema.adminGrants.email });
    if (demoted.length === 0 && revoked.length === 0) throw notFound('Administrador');
    return overview(tx);
  }));
}
