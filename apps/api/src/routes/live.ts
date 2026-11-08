/**
 * Sala remota de una partida presencial. Los jugadores que no están en la mesa entran (con el link o desde la partida),
 * ven el video de la mesa, mandan su cara y audio por el video de siempre y reciben **fotos** de las cartas que alguien
 * de la mesa les saca en el momento: las de la mesa las ven todos los de la sala; las cartas de cada remoto, solo él.
 * Las apuestas son por voz. Las fotos viven en la base solo mientras dura la mano (o la sala) y nunca van en URLs con token.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  ErrorResponse, IdParams, LiveCodeParams, LiveOperatorBody, LiveOperatorParams, LivePhotoBody, LivePhotoMeta, LivePhotoParams,
  LiveRoomRef, LiveRoomRefResponse, LiveView, type ApiLiveView,
} from '@pokercontrol/contracts';
import { type Static } from '@sinclair/typebox';
import { and, asc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { ApiError, notFound } from '../errors';
import type { Conn, Tx } from '../repo';
import { isEditor, requireEditor } from './groups';

const tags = ['live'];
const err = { '4xx': ErrorResponse };
/** Una foto reducida en el celular pesa ~150 KB: el tope corta lo que no es una foto de cartas. */
export const MAX_PHOTO_BYTES = 400 * 1024;
const MAX_PHOTOS_PER_HAND = 12;
/** Pausa mínima entre fotos de un mismo usuario (los tests la bajan con LIVE_PHOTO_MIN_MS). */
const photoMinMs = () => Number(process.env.LIVE_PHOTO_MIN_MS ?? 1000);
const ONLINE_MS = 45_000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

type RoomRow = typeof schema.liveRooms.$inferSelect;
type MemberRow = typeof schema.liveMembers.$inferSelect;

/** Canal del hub (sockets y video) de una sala: no se mezcla con el de la mesa online del grupo. */
export const roomChannel = (roomId: string) => `live:${roomId}`;

const newCode = () => Array.from(randomBytes(8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');

/** Cierra la sala de una partida (al cerrarla o anularla) y borra sus fotos. */
export async function closeRoomForSession(tx: Tx, sessionId: string): Promise<void> {
  const rooms = await tx.select({ id: schema.liveRooms.id }).from(schema.liveRooms)
    .where(and(eq(schema.liveRooms.sessionId, sessionId), eq(schema.liveRooms.status, 'open')));
  if (rooms.length === 0) return;
  const ids = rooms.map(r => r.id);
  await tx.delete(schema.livePhotos).where(inArray(schema.livePhotos.roomId, ids));
  await tx.update(schema.liveRooms).set({ status: 'closed', version: sql`${schema.liveRooms.version} + 1` })
    .where(inArray(schema.liveRooms.id, ids));
}

/** Borra las salas olvidadas (más de un día) con sus fotos. */
export async function purgeStaleRooms(db: Conn): Promise<number> {
  const old = await db.select({ id: schema.liveRooms.id }).from(schema.liveRooms)
    .where(lt(schema.liveRooms.createdAt, new Date(Date.now() - ROOM_TTL_MS)));
  if (old.length === 0) return 0;
  await db.delete(schema.liveRooms).where(inArray(schema.liveRooms.id, old.map(r => r.id)));
  return old.length;
}

/** Lee la foto de un body base64 (con o sin prefijo data:) y valida que sea un JPEG de tamaño razonable. */
export function decodeJpeg(image: string): Buffer {
  const raw = image.replace(/^data:image\/jpe?g;base64,/i, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw new ApiError(422, 'invalid_photo', 'La imagen no es válida.');
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) throw new ApiError(413, 'photo_too_large', 'La foto pesa demasiado: se reduce desde la app.');
  if (bytes.length < 100 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new ApiError(422, 'invalid_photo', 'Solo se aceptan fotos en formato JPEG.');
  }
  return bytes;
}

export async function liveRoutes(app: FastifyInstance) {
  type C = { Params: Static<typeof LiveCodeParams> };
  const lastPhoto = new Map<string, number>();

  async function roomByCode(db: Conn, groupId: string, code: string): Promise<RoomRow> {
    const [room] = await db.select().from(schema.liveRooms)
      .where(and(eq(schema.liveRooms.groupId, groupId), eq(schema.liveRooms.code, code.toLowerCase())));
    if (!room) throw notFound('Sala');
    return room;
  }

  const memberOf = async (db: Conn, roomId: string, userId: string): Promise<MemberRow | null> =>
    (await db.select().from(schema.liveMembers)
      .where(and(eq(schema.liveMembers.roomId, roomId), eq(schema.liveMembers.userId, userId))))[0] ?? null;

  /** Quien arma las fotos: administradores y los miembros que el host habilitó. */
  const canOperate = (req: { role: Parameters<typeof isEditor>[0] }, member: MemberRow | null) =>
    isEditor(req.role) || member?.role === 'operator';

  const bump = async (db: Conn, room: RoomRow) => {
    const [fresh] = await db.update(schema.liveRooms).set({ version: sql`${schema.liveRooms.version} + 1` })
      .where(eq(schema.liveRooms.id, room.id)).returning({ version: schema.liveRooms.version });
    app.tableHub.notify(roomChannel(room.id), fresh.version);
    return fresh.version;
  };

  async function viewOf(db: Conn, room: RoomRow, userId: string, role: Parameters<typeof isEditor>[0]): Promise<ApiLiveView> {
    const [session] = await db.select({ name: schema.sessions.name }).from(schema.sessions).where(eq(schema.sessions.id, room.sessionId));
    const members = await db.select({ m: schema.liveMembers, name: schema.players.name }).from(schema.liveMembers)
      .leftJoin(schema.players, eq(schema.players.id, schema.liveMembers.playerId))
      .where(eq(schema.liveMembers.roomId, room.id)).orderBy(asc(schema.liveMembers.userId));
    const mine = members.find(x => x.m.userId === userId)?.m ?? null;
    const operator = canOperate({ role }, mine);
    const joined = !!mine || isEditor(role);
    const photos = joined
      ? await db.select({
        id: schema.livePhotos.id, at: schema.livePhotos.createdAt, handNo: schema.livePhotos.handNo, kind: schema.livePhotos.kind,
        playerId: schema.livePhotos.playerId,
      }).from(schema.livePhotos).where(and(eq(schema.livePhotos.roomId, room.id), eq(schema.livePhotos.handNo, room.handNo)))
        .orderBy(asc(schema.livePhotos.createdAt))
      : [];
    const meta = (p: typeof photos[number]) => ({ id: p.id, at: p.at.toISOString(), handNo: p.handNo });
    const sent: Record<string, number> = {};
    if (operator) for (const p of photos) if (p.kind === 'hole' && p.playerId) sent[p.playerId] = (sent[p.playerId] ?? 0) + 1;
    const now = Date.now();
    return {
      id: room.id, code: room.code, status: room.status, sessionId: room.sessionId, sessionName: session?.name ?? '',
      version: room.version, handNo: room.handNo,
      me: mine ? { userId, playerId: mine.playerId, operator } : null,
      canManage: room.createdBy === userId || isEditor(role),
      members: members.filter(x => x.m.playerId).map(x => ({
        playerId: x.m.playerId as string, name: x.name ?? 'Jugador', userId: x.m.userId, operator: x.m.role === 'operator',
        online: now - x.m.lastSeenAt.getTime() < ONLINE_MS,
      })),
      board: photos.filter(p => p.kind === 'board').map(meta),
      myCards: mine?.playerId ? photos.filter(p => p.kind === 'hole' && p.playerId === mine.playerId).map(meta) : [],
      sent,
    };
  }

  // ─── Abrir y encontrar la sala de una partida ──────────────────────────────
  app.post<{ Params: Static<typeof IdParams> }>('/sessions/:id/live', {
    schema: { tags, params: IdParams, response: { 200: LiveRoomRef, ...err } },
  }, async req => {
    await requireEditor(req);
    const groupId = req.group.id;
    return app.db.transaction(async tx => {
      const [session] = await tx.select().from(schema.sessions)
        .where(and(eq(schema.sessions.groupId, groupId), eq(schema.sessions.id, req.params.id))).for('update');
      if (!session) throw notFound('Partida');
      if (session.status !== 'active') throw new ApiError(409, 'session_closed', 'Solo se abre una sala en una partida en juego.');
      await purgeStaleRooms(tx);
      const [existing] = await tx.select().from(schema.liveRooms).where(eq(schema.liveRooms.sessionId, session.id));
      if (existing) return { id: existing.id, code: existing.code, status: existing.status };
      const [room] = await tx.insert(schema.liveRooms)
        .values({ id: randomUUID(), groupId, sessionId: session.id, code: newCode(), createdBy: req.user.sub }).returning();
      // Quien la arma entra como operador.
      const [mine] = await tx.select({ id: schema.players.id }).from(schema.players)
        .where(and(eq(schema.players.groupId, groupId), eq(schema.players.userId, req.user.sub)));
      await tx.insert(schema.liveMembers).values({ roomId: room.id, userId: req.user.sub, playerId: mine?.id ?? null, role: 'operator' });
      return { id: room.id, code: room.code, status: room.status };
    });
  });

  app.get<{ Params: Static<typeof IdParams> }>('/sessions/:id/live', {
    schema: { tags, params: IdParams, response: { 200: LiveRoomRefResponse, ...err } },
  }, async req => {
    const [room] = await app.db.select().from(schema.liveRooms)
      .where(and(eq(schema.liveRooms.groupId, req.group.id), eq(schema.liveRooms.sessionId, req.params.id), eq(schema.liveRooms.status, 'open')));
    return { room: room ? { id: room.id, code: room.code, status: room.status } : null };
  });

  // ─── La sala ───────────────────────────────────────────────────────────────
  app.get<C>('/live/:code', {
    schema: { tags, params: LiveCodeParams, response: { 200: LiveView, ...err } },
  }, async req => viewOf(app.db, await roomByCode(app.db, req.group.id, req.params.code), req.user.sub, req.role));

  /** Entrar a la sala; se repite cada ~20 s como latido de presencia. */
  app.post<C>('/live/:code/join', {
    schema: { tags, params: LiveCodeParams, response: { 200: LiveView, ...err } },
  }, async req => {
    const room = await roomByCode(app.db, req.group.id, req.params.code);
    if (room.status !== 'open') throw new ApiError(409, 'room_closed', 'La sala ya se cerró.');
    const [player] = await app.db.select({ id: schema.players.id }).from(schema.players)
      .where(and(eq(schema.players.groupId, req.group.id), eq(schema.players.userId, req.user.sub)));
    if (!player && !isEditor(req.role)) {
      throw new ApiError(409, 'no_player', 'Elegí tu jugador del grupo antes de entrar a la sala.');
    }
    const before = await memberOf(app.db, room.id, req.user.sub);
    if (before) {
      await app.db.update(schema.liveMembers).set({ lastSeenAt: new Date(), playerId: player?.id ?? before.playerId })
        .where(and(eq(schema.liveMembers.roomId, room.id), eq(schema.liveMembers.userId, req.user.sub)));
    } else {
      await app.db.insert(schema.liveMembers).values({
        roomId: room.id, userId: req.user.sub, playerId: player?.id ?? null, role: isEditor(req.role) ? 'operator' : 'remote',
      });
      await bump(app.db, room); // aviso a los demás: alguien entró
    }
    return viewOf(app.db, (await roomByCode(app.db, req.group.id, req.params.code)), req.user.sub, req.role);
  });

  /** El host (o un administrador) habilita o saca a alguien de operador (puede sacar fotos). */
  app.post<{ Params: Static<typeof LiveOperatorParams>; Body: Static<typeof LiveOperatorBody> }>('/live/:code/operators/:userId', {
    schema: { tags, params: LiveOperatorParams, body: LiveOperatorBody, response: { 200: LiveView, ...err } },
  }, async req => {
    const room = await roomByCode(app.db, req.group.id, req.params.code);
    if (room.createdBy !== req.user.sub && !isEditor(req.role)) throw new ApiError(403, 'not_host', 'Lo decide quien armó la sala o un administrador.');
    const target = await memberOf(app.db, room.id, req.params.userId);
    if (!target) throw notFound('Participante');
    await app.db.update(schema.liveMembers).set({ role: req.body.operator ? 'operator' : 'remote' })
      .where(and(eq(schema.liveMembers.roomId, room.id), eq(schema.liveMembers.userId, req.params.userId)));
    await bump(app.db, room);
    return viewOf(app.db, room, req.user.sub, req.role);
  });

  // ─── Fotos ─────────────────────────────────────────────────────────────────
  app.post<C & { Body: Static<typeof LivePhotoBody> }>('/live/:code/photos', {
    bodyLimit: 800 * 1024,
    schema: { tags, params: LiveCodeParams, body: LivePhotoBody, response: { 200: LivePhotoMeta, ...err } },
  }, async req => {
    const room = await roomByCode(app.db, req.group.id, req.params.code);
    if (room.status !== 'open') throw new ApiError(409, 'room_closed', 'La sala ya se cerró.');
    const me = await memberOf(app.db, room.id, req.user.sub);
    if (!canOperate(req, me)) throw new ApiError(403, 'not_operator', 'Solo quien arma las fotos de la mesa puede mandarlas.');
    const now = Date.now();
    if (now - (lastPhoto.get(req.user.sub) ?? 0) < photoMinMs()) throw new ApiError(429, 'too_fast', 'Esperá un segundo entre fotos.');
    lastPhoto.set(req.user.sub, now);
    const bytes = decodeJpeg(req.body.image);
    const { kind, playerId } = req.body;
    if ((kind === 'hole') !== (playerId !== undefined)) {
      throw new ApiError(422, 'invalid_photo', kind === 'hole' ? 'Indicá de quién son las cartas.' : 'La foto de la mesa no lleva jugador.');
    }
    return app.db.transaction(async tx => {
      if (kind === 'hole') {
        const [owner] = await tx.select().from(schema.liveMembers)
          .where(and(eq(schema.liveMembers.roomId, room.id), eq(schema.liveMembers.playerId, playerId as string), ne(schema.liveMembers.role, 'operator')));
        if (!owner) throw new ApiError(422, 'not_in_room', 'Ese jugador no está conectado a la sala.');
        // Las cartas de un jugador se reemplazan: queda la última foto de la mano.
        await tx.delete(schema.livePhotos).where(and(
          eq(schema.livePhotos.roomId, room.id), eq(schema.livePhotos.handNo, room.handNo),
          eq(schema.livePhotos.kind, 'hole'), eq(schema.livePhotos.playerId, playerId as string),
        ));
      }
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.livePhotos)
        .where(and(eq(schema.livePhotos.roomId, room.id), eq(schema.livePhotos.handNo, room.handNo)));
      if (n >= MAX_PHOTOS_PER_HAND) throw new ApiError(409, 'too_many_photos', 'Ya hay muchas fotos en esta mano: pasá a la siguiente.');
      const [photo] = await tx.insert(schema.livePhotos).values({
        id: randomUUID(), roomId: room.id, handNo: room.handNo, kind, playerId: playerId ?? null, bytes, createdBy: req.user.sub,
      }).returning();
      await bump(tx, room);
      return { id: photo.id, at: photo.createdAt.toISOString(), handNo: photo.handNo };
    });
  });

  /** La imagen: la de la mesa, cualquier miembro de la sala; las cartas, su dueño o quien las sacó. Nunca se guarda en caché. */
  app.get<{ Params: Static<typeof LivePhotoParams> }>('/live/:code/photos/:photoId', {
    schema: { tags, params: LivePhotoParams, response: err },
  }, async (req, reply) => {
    const room = await roomByCode(app.db, req.group.id, req.params.code);
    const [photo] = await app.db.select().from(schema.livePhotos)
      .where(and(eq(schema.livePhotos.id, req.params.photoId), eq(schema.livePhotos.roomId, room.id)));
    if (!photo) throw notFound('Foto');
    const me = await memberOf(app.db, room.id, req.user.sub);
    const allowed = photo.kind === 'board'
      ? !!me || isEditor(req.role)
      : photo.createdBy === req.user.sub || (!!me?.playerId && me.playerId === photo.playerId);
    if (!allowed) throw notFound('Foto'); // no se revela que existe
    return reply.type('image/jpeg').header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').send(photo.bytes);
  });

  // ─── Manos y cierre ────────────────────────────────────────────────────────
  app.post<C>('/live/:code/new-hand', {
    schema: { tags, params: LiveCodeParams, response: { 200: LiveView, ...err } },
  }, async req => {
    const room = await roomByCode(app.db, req.group.id, req.params.code);
    if (room.status !== 'open') throw new ApiError(409, 'room_closed', 'La sala ya se cerró.');
    if (!canOperate(req, await memberOf(app.db, room.id, req.user.sub))) throw new ApiError(403, 'not_operator', 'Solo quien arma las fotos puede pasar de mano.');
    await app.db.transaction(async tx => {
      await tx.delete(schema.livePhotos).where(eq(schema.livePhotos.roomId, room.id));
      await tx.update(schema.liveRooms).set({ handNo: sql`${schema.liveRooms.handNo} + 1` }).where(eq(schema.liveRooms.id, room.id));
      await bump(tx, room);
    });
    return viewOf(app.db, await roomByCode(app.db, req.group.id, req.params.code), req.user.sub, req.role);
  });

  app.post<C>('/live/:code/close', {
    schema: { tags, params: LiveCodeParams, response: { 200: LiveView, ...err } },
  }, async req => {
    const room = await roomByCode(app.db, req.group.id, req.params.code);
    if (room.createdBy !== req.user.sub && !isEditor(req.role)) throw new ApiError(403, 'not_host', 'Cierra la sala quien la armó o un administrador.');
    await app.db.transaction(async tx => {
      await tx.delete(schema.livePhotos).where(eq(schema.livePhotos.roomId, room.id));
      await tx.update(schema.liveRooms).set({ status: 'closed' }).where(eq(schema.liveRooms.id, room.id));
      await bump(tx, room);
    });
    return viewOf(app.db, await roomByCode(app.db, req.group.id, req.params.code), req.user.sub, req.role);
  });
}
