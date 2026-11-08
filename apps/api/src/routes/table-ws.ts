/**
 * WebSocket de avisos de la mesa: /api/v1/groups/:groupId/table/ws
 *
 * El navegador no puede mandar headers en un WebSocket y poner el JWT en la URL lo deja en
 * los logs, así que el primer mensaje es { type: "auth", token }. Sin él en 5 s se cierra.
 * Los avisos son { type: "changed", version }; los datos se piden por HTTP. Lo único que un cliente
 * autenticado puede mandar es señalización del video ({ type: "rtc", ... }), que el hub reenvía, y emojis
 * de una paleta fija ({ type: "emoji", id }), que se reparten a todos los conectados sin guardarse.
 */

import { EmojiClientMessage, RtcClientMessage } from '@pokercontrol/contracts';
import { Value } from '@sinclair/typebox/value';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import * as schema from '../db/schema';
import { canAccessGroup, isEditor } from './groups';
import { roomChannel } from './live';

const AUTH_TIMEOUT_MS = 5000;
const PING_MS = 25_000;
/** Una oferta SDP ronda los 5 KB; el tope corta lo que no es señalización (también lo usa el plugin de WebSocket). */
export const MAX_SIGNAL_BYTES = 16 * 1024;
/** Antes de autenticar solo se espera { type: "auth", token }. */
const MAX_AUTH_BYTES = 2048;
/** Negociar con 5 pares genera unas decenas de candidatos ICE: el tope solo frena abusos. */
const SIGNAL_WINDOW_MS = 10_000;
const SIGNAL_MAX_PER_WINDOW = 300;
/** Un emoji por conexión cada tanto: son para festejar, no para inundar la mesa. */
const EMOJI_MIN_MS = 1500;
export const WS_CLOSE = { unauthorized: 4401, forbidden: 4403 } as const;

export async function tableSocketRoutes(app: FastifyInstance) {
  app.get<{ Params: { groupId: string }; Querystring: { room?: string } }>('/groups/:groupId/table/ws', {
    websocket: true,
    schema: { hide: true },
  }, (socket, req) => {
    const { groupId } = req.params;
    // Con ?room=<id> el socket es de una sala remota: tiene su propio canal (avisos, video, emojis) y entran solo sus miembros.
    const roomId = typeof req.query.room === 'string' && req.query.room.length <= 64 ? req.query.room : null;
    let channel = groupId;
    let canBroadcastTable = false;
    let unsubscribe: (() => void) | null = null;
    let authed = false;
    let alive = true;

    const authTimer = setTimeout(() => { if (!authed) socket.close(WS_CLOSE.unauthorized, 'auth timeout'); }, AUTH_TIMEOUT_MS);
    // Corta conexiones muertas (los proxies cierran las inactivas) y mantiene viva la abierta.
    const pingTimer = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      try { socket.ping(); } catch { /* se limpia en close */ }
    }, PING_MS);
    socket.on('pong', () => { alive = true; });

    let signals = 0;
    let signalWindowStart = Date.now();
    let userId = '';
    const playerOf = async (): Promise<string | null> => {
      const [player] = await app.db.select({ id: schema.players.id }).from(schema.players)
        .where(and(eq(schema.players.groupId, groupId), eq(schema.players.userId, userId)));
      return player?.id ?? null;
    };

    /** Quién manda un emoji: su jugador en el grupo o, si no tiene (administrador que mira), su usuario. */
    const whoIs = async (): Promise<{ playerId: string | null; name: string }> => {
      const [player] = await app.db.select({ id: schema.players.id, name: schema.players.name }).from(schema.players)
        .where(and(eq(schema.players.groupId, groupId), eq(schema.players.userId, userId)));
      if (player) return { playerId: player.id, name: player.name };
      const [user] = await app.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId));
      return { playerId: null, name: user?.name ?? 'Alguien' };
    };
    let lastEmoji = 0;
    const handleEmoji = async (msg: unknown) => {
      if (!Value.Check(EmojiClientMessage, msg)) return;
      const now = Date.now();
      if (now - lastEmoji < EMOJI_MIN_MS) return;
      lastEmoji = now; // antes del await: dos mensajes seguidos no se cuelan juntos
      try {
        const who = await whoIs();
        app.tableHub.broadcast(channel, JSON.stringify({ type: 'emoji', id: msg.id, playerId: who.playerId, name: who.name.slice(0, 60) }));
      } catch { /* sin respuesta: se ignora */ }
    };

    /** Mensajes de video y emojis; todo lo demás que mande un cliente ya autenticado se ignora. */
    const handleSignal = async (raw: Buffer) => {
      if (raw.length > MAX_SIGNAL_BYTES) return;
      const now = Date.now();
      if (now - signalWindowStart > SIGNAL_WINDOW_MS) { signalWindowStart = now; signals = 0; }
      if (++signals > SIGNAL_MAX_PER_WINDOW) return socket.close(1008, 'rate limit');
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'emoji') return handleEmoji(msg);
      if (!Value.Check(RtcClientMessage, msg)) return;
      // Todo menos start/stop va dirigido a una conexión concreta.
      const targeted = msg.kind !== 'start' && msg.kind !== 'stop';
      if (targeted !== (msg.to !== undefined)) return;
      // Quien se sienta o elige su nick con la mesa abierta no estaba como jugador al conectarse.
      if (msg.kind === 'start') {
        // La cámara de la mesa solo se transmite dentro de una sala remota.
        if (msg.source === 'table' && !canBroadcastTable) return;
        try { app.tableHub.setPlayer(channel, socket, await playerOf()); } catch { return; }
        if (socket.readyState !== socket.OPEN) return;
      }
      app.tableHub.relay(channel, socket, msg);
    };

    socket.on('message', async (raw: Buffer) => {
      alive = true;
      if (authed) return handleSignal(raw);
      if (raw.length > MAX_AUTH_BYTES) return socket.close(WS_CLOSE.unauthorized, 'auth too large');
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: unknown };
        if (msg.type !== 'auth' || typeof msg.token !== 'string') return socket.close(WS_CLOSE.unauthorized, 'auth required');
        const payload = app.jwt.verify<{ sub: string }>(msg.token);
        if (!(await canAccessGroup(app.db, payload.sub, groupId))) return socket.close(WS_CLOSE.forbidden, 'forbidden');
        if (socket.readyState !== socket.OPEN || authed) return;
        // Sin jugador propio (p. ej. un administrador) mira el video de los demás pero no transmite.
        userId = payload.sub;
        if (roomId) {
          // Sala remota: debe existir, estar abierta y ser de este grupo; entran quienes se unieron a ella y los administradores.
          const [room] = await app.db.select().from(schema.liveRooms)
            .where(and(eq(schema.liveRooms.id, roomId), eq(schema.liveRooms.groupId, groupId), eq(schema.liveRooms.status, 'open')));
          if (!room) return socket.close(WS_CLOSE.forbidden, 'room not found');
          const [role] = await app.db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId));
          const [member] = await app.db.select({ role: schema.liveMembers.role }).from(schema.liveMembers)
            .where(and(eq(schema.liveMembers.roomId, roomId), eq(schema.liveMembers.userId, userId)));
          const editor = isEditor(role?.role ?? null);
          if (!member && !editor) return socket.close(WS_CLOSE.forbidden, 'not in room');
          // Todos los de la sala pueden transmitir el video de la mesa.
          canBroadcastTable = editor || !!member;
          channel = roomChannel(roomId);
        }
        const playerId = await playerOf();
        if (socket.readyState !== socket.OPEN || authed) return;
        authed = true;
        clearTimeout(authTimer);
        unsubscribe = app.tableHub.subscribe(channel, socket, playerId);
        socket.send(JSON.stringify({ type: 'ready' }));
        app.tableHub.announceBroadcasters(channel, socket);
      } catch {
        socket.close(WS_CLOSE.unauthorized, 'invalid token');
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(pingTimer);
      unsubscribe?.();
    });
    socket.on('error', () => socket.terminate());
  });
}
