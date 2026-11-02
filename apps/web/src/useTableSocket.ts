import { useEffect, useRef, useState } from 'react';
import { getToken, wsUrl } from './api';

/** Cierres por los que reconectar no sirve: sin sesión válida (4401) o sin acceso al grupo (4403). */
const FATAL = new Set([4401, 4403]);

/**
 * Escucha los avisos de la mesa. El socket solo dice "cambió": los datos se
 * piden por HTTP, así que si se corta no se pierde nada, solo se vuelve al polling.
 * Devuelve si hay conexión en vivo. Reconecta con espera creciente (1 s hasta 15 s).
 */
export function useTableSocket(groupId: string, onChanged: () => void): boolean {
  const [live, setLive] = useState(false);
  const callback = useRef(onChanged);
  callback.current = onChanged;

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const token = getToken();
      if (!token || stopped) return;
      const ws = new WebSocket(wsUrl(`/groups/${groupId}/table/ws`));
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = event => {
        try {
          const msg = JSON.parse(String(event.data)) as { type?: string };
          if (msg.type === 'ready') {
            attempt = 0;
            setLive(true);
            callback.current(); // por si hubo cambios mientras no estaba conectado
          } else if (msg.type === 'changed') {
            callback.current();
          }
        } catch { /* mensaje ajeno: se ignora */ }
      };
      ws.onclose = event => {
        setLive(false);
        if (stopped || FATAL.has(event.code)) return;
        timer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** attempt++));
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      setLive(false);
    };
  }, [groupId]);

  return live;
}
