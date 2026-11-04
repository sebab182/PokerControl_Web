import type { ApiEmojiServerMessage, ApiRtcClientMessage, ApiRtcServerMessage, TableEmojiId } from '@pokercontrol/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken, wsUrl } from './api';

/** Cierres por los que reconectar no sirve: sin sesión válida (4401) o sin acceso al grupo (4403). */
const FATAL = new Set([4401, 4403]);

export interface TableSocket {
  /** ¿Hay conexión en vivo? */
  live: boolean;
  /** Manda señalización del video; si no hay conexión, se descarta (la renegociación la rehace al reconectar). */
  send: (msg: Omit<ApiRtcClientMessage, 'type'>) => void;
  /** Manda un emoji de la paleta a la mesa; si no hay conexión, se descarta. */
  sendEmoji: (id: TableEmojiId) => void;
}

/**
 * Escucha los avisos de la mesa. El socket solo dice "cambió": los datos se
 * piden por HTTP, así que si se corta no se pierde nada, solo se vuelve al polling.
 * Por el mismo canal pasa la señalización del video (`onSignal`) y los emojis (`onEmoji`). Reconecta con espera
 * creciente (1 s hasta 15 s).
 */
export function useTableSocket(
  groupId: string, onChanged: () => void, onSignal?: (msg: ApiRtcServerMessage) => void,
  onEmoji?: (msg: ApiEmojiServerMessage) => void,
): TableSocket {
  const [live, setLive] = useState(false);
  const callback = useRef(onChanged);
  callback.current = onChanged;
  const signalCallback = useRef(onSignal);
  signalCallback.current = onSignal;
  const emojiCallback = useRef(onEmoji);
  emojiCallback.current = onEmoji;
  const current = useRef<WebSocket | null>(null);

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
            current.current = ws;
            setLive(true);
            callback.current(); // por si hubo cambios mientras no estaba conectado
          } else if (msg.type === 'changed') {
            callback.current();
          } else if (msg.type === 'rtc') {
            signalCallback.current?.(msg as ApiRtcServerMessage);
          } else if (msg.type === 'emoji') {
            emojiCallback.current?.(msg as ApiEmojiServerMessage);
          }
        } catch { /* mensaje ajeno: se ignora */ }
      };
      ws.onclose = event => {
        if (current.current === ws) current.current = null;
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
      current.current = null;
      setLive(false);
    };
  }, [groupId]);

  const send = useCallback((msg: Omit<ApiRtcClientMessage, 'type'>) => {
    const ws = current.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'rtc', ...msg }));
  }, []);

  const sendEmoji = useCallback((id: TableEmojiId) => {
    const ws = current.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'emoji', id }));
  }, []);

  return { live, send, sendEmoji };
}
