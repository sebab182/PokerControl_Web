/**
 * Canal de avisos de la mesa: por cada grupo, los sockets conectados. Solo transporta
 * "la mesa cambió" (sin cartas ni datos): cada cliente vuelve a pedir su vista por HTTP,
 * así la información oculta sigue saliendo únicamente por GET /table.
 *
 * En memoria: sirve para una sola instancia de la API (Render free). Con varias habría
 * que reemplazarlo por LISTEN/NOTIFY; el polling lento de la web cubre cualquier pérdida.
 */

export interface HubSocket {
  send(data: string): void;
  readyState: number;
}

const OPEN = 1;

export class TableHub {
  private groups = new Map<string, Set<HubSocket>>();

  subscribe(groupId: string, socket: HubSocket): () => void {
    let set = this.groups.get(groupId);
    if (!set) this.groups.set(groupId, (set = new Set()));
    set.add(socket);
    return () => {
      set.delete(socket);
      if (set.size === 0 && this.groups.get(groupId) === set) this.groups.delete(groupId);
    };
  }

  notify(groupId: string, version: number): void {
    const message = JSON.stringify({ type: 'changed', version });
    for (const socket of this.groups.get(groupId) ?? []) {
      if (socket.readyState !== OPEN) continue;
      try { socket.send(message); } catch { /* el socket se limpia al cerrarse */ }
    }
  }

  count(groupId: string): number {
    return this.groups.get(groupId)?.size ?? 0;
  }
}
