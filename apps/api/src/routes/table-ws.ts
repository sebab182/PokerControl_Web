/**
 * WebSocket de avisos de la mesa: /api/v1/groups/:groupId/table/ws
 *
 * El navegador no puede mandar headers en un WebSocket y poner el JWT en la URL lo deja en
 * los logs, así que el primer mensaje es { type: "auth", token }. Sin él en 5 s se cierra.
 * Solo se envían avisos { type: "changed", version }; los datos se piden por HTTP.
 */

import type { FastifyInstance } from 'fastify';
import { canAccessGroup } from './groups';

const AUTH_TIMEOUT_MS = 5000;
const PING_MS = 25_000;
export const WS_CLOSE = { unauthorized: 4401, forbidden: 4403 } as const;

export async function tableSocketRoutes(app: FastifyInstance) {
  app.get<{ Params: { groupId: string } }>('/groups/:groupId/table/ws', {
    websocket: true,
    schema: { hide: true },
  }, (socket, req) => {
    const { groupId } = req.params;
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

    socket.on('message', async (raw: Buffer) => {
      alive = true;
      if (authed) return; // los clientes no mandan nada más: se ignora
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; token?: unknown };
        if (msg.type !== 'auth' || typeof msg.token !== 'string') return socket.close(WS_CLOSE.unauthorized, 'auth required');
        const payload = app.jwt.verify<{ sub: string }>(msg.token);
        if (!(await canAccessGroup(app.db, payload.sub, groupId))) return socket.close(WS_CLOSE.forbidden, 'forbidden');
        if (socket.readyState !== socket.OPEN || authed) return;
        authed = true;
        clearTimeout(authTimer);
        unsubscribe = app.tableHub.subscribe(groupId, socket);
        socket.send(JSON.stringify({ type: 'ready' }));
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
