/**
 * Canal de avisos de la mesa: por cada grupo, los sockets conectados. Solo transporta
 * "la mesa cambió" (sin cartas ni datos): cada cliente vuelve a pedir su vista por HTTP,
 * así la información oculta sigue saliendo únicamente por GET /table.
 *
 * También reenvía la señalización del video (WebRTC): el servidor no ve ni toca el video,
 * que va de navegador a navegador; solo pasa los mensajes de negociación entre conexiones.
 *
 * En memoria: sirve para una sola instancia de la API (Render free). Con varias habría
 * que reemplazarlo por LISTEN/NOTIFY; el polling lento de la web cubre cualquier pérdida.
 */

import { randomUUID } from 'node:crypto';
import type { ApiRtcKind, ApiRtcServerMessage } from '@pokercontrol/contracts';

export interface HubSocket {
  send(data: string): void;
  readyState: number;
}

/** Una conexión de la mesa. `id` lo asigna el servidor; los clientes se direccionan con él. */
interface Peer {
  id: string;
  playerId: string | null;
  broadcasting: boolean;
}

const OPEN = 1;

export class TableHub {
  private groups = new Map<string, Map<HubSocket, Peer>>();

  subscribe(groupId: string, socket: HubSocket, playerId: string | null = null): () => void {
    let peers = this.groups.get(groupId);
    if (!peers) this.groups.set(groupId, (peers = new Map()));
    const peer: Peer = { id: randomUUID(), playerId, broadcasting: false };
    peers.set(socket, peer);
    return () => {
      // Si se cae quien transmitía, los demás tienen que dejar de esperar su video.
      if (peer.broadcasting) this.relay(groupId, socket, { kind: 'stop' });
      peers.delete(socket);
      if (peers.size === 0 && this.groups.get(groupId) === peers) this.groups.delete(groupId);
    };
  }

  notify(groupId: string, version: number): void {
    const message = JSON.stringify({ type: 'changed', version });
    for (const socket of this.groups.get(groupId)?.keys() ?? []) this.deliver(socket, message);
  }

  count(groupId: string): number {
    return this.groups.get(groupId)?.size ?? 0;
  }

  /** El jugador de una conexión puede cambiar con el socket abierto (p. ej. elige su nick después de entrar). */
  setPlayer(groupId: string, socket: HubSocket, playerId: string | null): void {
    const peer = this.groups.get(groupId)?.get(socket);
    if (peer) peer.playerId = playerId;
  }

  /** Quienes están transmitiendo ahora, para el que recién se conecta. */
  announceBroadcasters(groupId: string, socket: HubSocket): void {
    for (const [other, peer] of this.groups.get(groupId) ?? []) {
      if (other === socket || !peer.broadcasting) continue;
      this.deliver(socket, JSON.stringify(this.message(peer, 'start')));
    }
  }

  /**
   * Reenvía un mensaje de video. Sin `to` le llega a todos los demás de la mesa; con `to`, solo a esa
   * conexión (si sigue en el mismo grupo). start/stop además marcan si esta conexión está transmitiendo.
   * Devuelve false si el mensaje no se puede cursar (p. ej. empezar a transmitir sin tener jugador).
   */
  relay(groupId: string, from: HubSocket, msg: { kind: ApiRtcKind; to?: string; data?: unknown }): boolean {
    const peers = this.groups.get(groupId);
    const sender = peers?.get(from);
    if (!peers || !sender) return false;

    if (msg.kind === 'start') {
      if (!sender.playerId) return false;
      sender.broadcasting = true;
    } else if (msg.kind === 'stop') {
      if (!sender.broadcasting) return true; // ya estaba cortada: nada que avisar
      sender.broadcasting = false;
    }

    const payload = JSON.stringify(this.message(sender, msg.kind, msg.data));
    for (const [socket, peer] of peers) {
      if (socket === from) continue;
      if (msg.to ? peer.id === msg.to : msg.kind === 'start' || msg.kind === 'stop') this.deliver(socket, payload);
    }
    return true;
  }

  private message(peer: Peer, kind: ApiRtcKind, data?: unknown): ApiRtcServerMessage {
    return { type: 'rtc', kind, from: peer.id, playerId: peer.playerId, ...(data === undefined ? {} : { data }) };
  }

  private deliver(socket: HubSocket, payload: string): void {
    if (socket.readyState !== OPEN) return;
    try { socket.send(payload); } catch { /* el socket se limpia al cerrarse */ }
  }
}
