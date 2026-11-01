import { randomInt, randomUUID } from 'node:crypto';
import {
  CreateGroupBody, ErrorResponse, Group, GroupParams, GroupRef, JoinGroupBody, Ok, UpdateGroupBody,
} from '@pokercontrol/contracts';
import { createSeason } from '@pokercontrol/core';
import type { Static } from '@sinclair/typebox';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as schema from '../db/schema';
import { ApiError } from '../errors';
import { ctx, type Conn } from '../repo';
import { userGroups } from './auth';

type Params = { Params: Static<typeof GroupParams> };

/** Sin caracteres ambiguos (0/O, 1/I/L), porque el código se comparte de palabra. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

function newInviteCode(): string {
  return Array.from({ length: 8 }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join('');
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: timezone });
  } catch {
    throw new ApiError(422, 'invalid_timezone', 'Zona horaria inválida.');
  }
}

export async function requireMembership(req: FastifyRequest): Promise<void> {
  const { groupId } = req.params as { groupId: string };
  const [row] = await req.server.db.select({ id: schema.groups.id, timezone: schema.groups.timezone })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, req.user.sub)));
  if (!row) throw new ApiError(403, 'not_a_member', 'No pertenecés a este grupo.');
  req.group = row;
}

async function loadGroup(db: Conn, groupId: string) {
  const [group] = await db.select().from(schema.groups).where(eq(schema.groups.id, groupId));
  const members = await db.select({
    id: schema.users.id, name: schema.users.name, email: schema.users.email, joinedAt: schema.groupMembers.joinedAt,
  }).from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .where(eq(schema.groupMembers.groupId, groupId))
    .orderBy(schema.groupMembers.joinedAt);
  return {
    id: group.id,
    name: group.name,
    inviteCode: group.inviteCode,
    timezone: group.timezone,
    createdAt: group.createdAt.toISOString(),
    members: members.map(m => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
  };
}

export async function groupRoutes(app: FastifyInstance) {
  const scoped = { preHandler: requireMembership };
  const err = { '4xx': ErrorResponse };

  app.get('/groups', {
    schema: { tags: ['groups'], response: { 200: { type: 'array', items: GroupRef }, ...err } },
  }, async req => userGroups(app.db, req.user.sub));

  app.post<{ Body: Static<typeof CreateGroupBody> }>('/groups', {
    schema: { tags: ['groups'], body: CreateGroupBody, response: { 200: Group, ...err } },
  }, async req => {
    const timezone = req.body.timezone ?? DEFAULT_TIMEZONE;
    assertTimezone(timezone);
    const name = req.body.name.trim();
    if (!name) throw new ApiError(422, 'invalid_name', 'El nombre no puede estar vacío.');
    const groupId = randomUUID();
    return app.db.transaction(async tx => {
      await tx.insert(schema.groups).values({
        id: groupId, name, timezone, inviteCode: newInviteCode(), createdBy: req.user.sub,
      });
      await tx.insert(schema.groupMembers).values({ groupId, userId: req.user.sub });
      const { created } = createSeason([], 'Temporada 1', ctx);
      await tx.insert(schema.seasons).values({
        id: created.id, groupId, name: created.name, status: 'active', createdAt: new Date(created.createdAt),
      });
      return loadGroup(tx, groupId);
    });
  });

  app.post<{ Body: Static<typeof JoinGroupBody> }>('/groups/join', {
    config: { rateLimit: { max: app.rateLimitMax, timeWindow: '1 minute' } },
    schema: { tags: ['groups'], body: JoinGroupBody, response: { 200: GroupRef, ...err } },
  }, async req => {
    const [group] = await app.db.select({ id: schema.groups.id, name: schema.groups.name })
      .from(schema.groups).where(eq(schema.groups.inviteCode, req.body.inviteCode.trim().toUpperCase()));
    if (!group) throw new ApiError(404, 'invalid_code', 'El código de invitación no es válido.');
    const inserted = await app.db.insert(schema.groupMembers)
      .values({ groupId: group.id, userId: req.user.sub })
      .onConflictDoNothing().returning();
    if (inserted.length === 0) throw new ApiError(409, 'already_member', 'Ya sos miembro de este grupo.');
    return group;
  });

  app.get<Params>('/groups/:groupId', {
    ...scoped,
    schema: { tags: ['groups'], params: GroupParams, response: { 200: Group, ...err } },
  }, async req => loadGroup(app.db, req.group.id));

  app.patch<Params & { Body: Static<typeof UpdateGroupBody> }>('/groups/:groupId', {
    ...scoped,
    schema: { tags: ['groups'], params: GroupParams, body: UpdateGroupBody, response: { 200: Group, ...err } },
  }, async req => {
    const { name, timezone } = req.body;
    if (timezone) assertTimezone(timezone);
    const trimmed = name?.trim();
    if (name !== undefined && !trimmed) throw new ApiError(422, 'invalid_name', 'El nombre no puede estar vacío.');
    if (trimmed || timezone) {
      await app.db.update(schema.groups)
        .set({ ...(trimmed ? { name: trimmed } : {}), ...(timezone ? { timezone } : {}) })
        .where(eq(schema.groups.id, req.group.id));
    }
    return loadGroup(app.db, req.group.id);
  });

  app.post<Params>('/groups/:groupId/invite/rotate', {
    ...scoped,
    schema: { tags: ['groups'], params: GroupParams, response: { 200: Group, ...err } },
  }, async req => {
    await app.db.update(schema.groups).set({ inviteCode: newInviteCode() }).where(eq(schema.groups.id, req.group.id));
    return loadGroup(app.db, req.group.id);
  });

  app.delete<Params>('/groups/:groupId/members/me', {
    ...scoped,
    schema: { tags: ['groups'], params: GroupParams, response: { 200: Ok, ...err } },
  }, async req => app.db.transaction(async tx => {
    await tx.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, req.group.id)).for('no key update');
    const [{ value }] = await tx.select({ value: count() }).from(schema.groupMembers)
      .where(eq(schema.groupMembers.groupId, req.group.id));
    if (value <= 1) throw new ApiError(409, 'last_member', 'Sos el último miembro: no podés abandonar el grupo.');
    await tx.delete(schema.groupMembers).where(and(
      eq(schema.groupMembers.groupId, req.group.id),
      eq(schema.groupMembers.userId, req.user.sub),
    ));
    return { ok: true };
  }));
}
