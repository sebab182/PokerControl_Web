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
import { userGroups, userRole, type Role } from './auth';

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

const isEditor = (role: Role | null) => role === 'master' || role === 'admin';

/** Master y admins entran a cualquier grupo; solo lectura, a aquellos donde es miembro. */
export async function requireMembership(req: FastifyRequest): Promise<void> {
  const { groupId } = req.params as { groupId: string };
  const role = await userRole(req.server.db, req.user.sub);
  const db = req.server.db;
  const [group] = await db.select({ id: schema.groups.id, timezone: schema.groups.timezone })
    .from(schema.groups).where(eq(schema.groups.id, groupId));
  const [member] = group
    ? await db.select({ userId: schema.groupMembers.userId }).from(schema.groupMembers)
      .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, req.user.sub)))
    : [];
  if (!group || (!member && !isEditor(role))) throw new ApiError(403, 'not_a_member', 'No pertenecés a este grupo.');
  req.group = group;
  req.role = role ?? 'reader';
}

/** ¿Puede este usuario ver el grupo? Mismo criterio que requireMembership, para quien no pasa por una request HTTP. */
export async function canAccessGroup(db: Conn, userId: string, groupId: string): Promise<boolean> {
  const role = await userRole(db, userId);
  const [group] = await db.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, groupId));
  if (!group) return false;
  if (isEditor(role)) return true;
  const [member] = await db.select({ userId: schema.groupMembers.userId }).from(schema.groupMembers)
    .where(and(eq(schema.groupMembers.groupId, groupId), eq(schema.groupMembers.userId, userId)));
  return !!member;
}

/** Corre después de requireMembership. */
export async function requireEditor(req: FastifyRequest): Promise<void> {
  if (!isEditor(req.role)) throw new ApiError(403, 'read_only', 'Tu usuario es de solo lectura.');
}

async function loadGroup(db: Conn, groupId: string, viewer: { id: string; role: Role | null }) {
  const [group] = await db.select().from(schema.groups).where(eq(schema.groups.id, groupId));
  const members = await db.select({
    id: schema.users.id,
    name: schema.users.name,
    email: schema.users.email,
    joinedAt: schema.groupMembers.joinedAt,
    playerId: schema.players.id,
  }).from(schema.groupMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.groupMembers.userId))
    .leftJoin(schema.players, and(eq(schema.players.groupId, groupId), eq(schema.players.userId, schema.users.id)))
    .where(eq(schema.groupMembers.groupId, groupId))
    .orderBy(schema.groupMembers.joinedAt);
  const editor = isEditor(viewer.role);
  return {
    id: group.id,
    name: group.name,
    inviteCode: editor ? group.inviteCode : null,
    timezone: group.timezone,
    createdAt: group.createdAt.toISOString(),
    isMember: members.some(m => m.id === viewer.id),
    members: members.map(({ email, ...m }) => ({
      ...m, joinedAt: m.joinedAt.toISOString(), ...(editor ? { email } : {}),
    })),
  };
}

export async function groupRoutes(app: FastifyInstance) {
  const scoped = { preValidation: requireMembership };
  const editors = { preValidation: [requireMembership, requireEditor] };
  const err = { '4xx': ErrorResponse };
  const viewer = (req: FastifyRequest) => ({ id: req.user.sub, role: req.role });

  app.get('/groups', {
    schema: { tags: ['groups'], response: { 200: { type: 'array', items: GroupRef }, ...err } },
  }, async req => userGroups(app.db, req.user.sub));

  app.post<{ Body: Static<typeof CreateGroupBody> }>('/groups', {
    preValidation: async req => {
      req.role = await userRole(app.db, req.user.sub) ?? 'reader';
      await requireEditor(req);
    },
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
      return loadGroup(tx, groupId, viewer(req));
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
    const refs = await userGroups(app.db, req.user.sub);
    return refs.find(g => g.id === group.id) ?? { ...group, playerId: null };
  });

  app.get<Params>('/groups/:groupId', {
    ...scoped,
    schema: { tags: ['groups'], params: GroupParams, response: { 200: Group, ...err } },
  }, async req => loadGroup(app.db, req.group.id, viewer(req)));

  app.patch<Params & { Body: Static<typeof UpdateGroupBody> }>('/groups/:groupId', {
    ...editors,
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
    return loadGroup(app.db, req.group.id, viewer(req));
  });

  app.post<Params>('/groups/:groupId/invite/rotate', {
    ...editors,
    schema: { tags: ['groups'], params: GroupParams, response: { 200: Group, ...err } },
  }, async req => {
    await app.db.update(schema.groups).set({ inviteCode: newInviteCode() }).where(eq(schema.groups.id, req.group.id));
    return loadGroup(app.db, req.group.id, viewer(req));
  });

  app.delete<Params>('/groups/:groupId/members/me', {
    ...scoped,
    schema: { tags: ['groups'], params: GroupParams, response: { 200: Ok, ...err } },
  }, async req => app.db.transaction(async tx => {
    await tx.select({ id: schema.groups.id }).from(schema.groups).where(eq(schema.groups.id, req.group.id)).for('no key update');
    const membership = and(
      eq(schema.groupMembers.groupId, req.group.id),
      eq(schema.groupMembers.userId, req.user.sub),
    );
    const [member] = await tx.select({ userId: schema.groupMembers.userId }).from(schema.groupMembers).where(membership);
    if (!member) throw new ApiError(409, 'not_a_member', 'No figurás como miembro de este grupo.');
    const [{ value }] = await tx.select({ value: count() }).from(schema.groupMembers)
      .where(eq(schema.groupMembers.groupId, req.group.id));
    if (value <= 1) throw new ApiError(409, 'last_member', 'Sos el último miembro: no podés abandonar el grupo.');
    await tx.delete(schema.groupMembers).where(membership);
    await tx.update(schema.players).set({ userId: null })
      .where(and(eq(schema.players.groupId, req.group.id), eq(schema.players.userId, req.user.sub)));
    return { ok: true };
  }));
}
