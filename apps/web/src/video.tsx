import type { ApiRtcServerMessage } from '@pokercontrol/contracts';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Btn } from './components/ui';
import type { TableSocket } from './useTableSocket';

/**
 * Video de la mesa: WebRTC de navegador a navegador (malla), que viaja por UDP. La API solo pasa la
 * negociación por el WebSocket de la mesa (ver table-ws.ts); no ve el video.
 *
 * Quien transmite le arma una conexión a cada espectador, así que lo sube N-1 veces: sirve para mesas
 * chicas (2 a 6). Roles fijos, sin choques de oferta: el espectador pide ("watch") y el que transmite ofrece.
 */

const MAX_BITRATE = 150_000;
const ICE_SERVERS: RTCIceServer[] = (() => {
  try {
    const custom = import.meta.env.VITE_ICE_SERVERS as string | undefined; // JSON, p. ej. para sumar un TURN
    if (custom) return JSON.parse(custom) as RTCIceServer[];
  } catch { /* configuración inválida: se usa el STUN público */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
})();

const CAMERA: MediaTrackConstraints = { width: { ideal: 240 }, height: { ideal: 180 }, frameRate: { ideal: 12, max: 15 }, facingMode: 'user' };

/** Se puede transmitir si el navegador tiene WebRTC y cámara; el contexto seguro (https/localhost) lo exige. */
export const videoSupported = () =>
  typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** De qué lado de la conexión sale un candidato ICE; sirve para que el otro extremo lo asigne a la conexión correcta. */
type IceData = { dir: 'out' | 'in'; candidate: RTCIceCandidateInit };

interface VideoState {
  supported: boolean;
  /** Mi transmisión: null si no estoy transmitiendo. */
  local: MediaStream | null;
  micOn: boolean;
  starting: boolean;
  error: string | null;
  /** Video de los demás, por jugador. */
  remote: ReadonlyMap<string, MediaStream>;
  /** Silencia el audio que llega de los demás (solo en este dispositivo). */
  muteOthers: boolean;
  setMuteOthers: (v: boolean) => void;
  /** Con micrófono o sin él. Si ya transmitía, reinicia la transmisión con la nueva opción. */
  start: (withMic: boolean) => Promise<void>;
  stop: () => void;
  /** Quién puede transmitir: solo quien tiene jugador. */
  canBroadcast: boolean;
  myPlayerId: string | null;
}

const VideoContext = createContext<VideoState | null>(null);

export function useVideo(): VideoState | null {
  return useContext(VideoContext);
}

/** Video de un jugador: el mío si soy yo, el recibido si no. */
export function useSeatStream(playerId: string): MediaStream | null {
  const v = useVideo();
  if (!v) return null;
  return playerId === v.myPlayerId ? v.local : v.remote.get(playerId) ?? null;
}

interface Link { pc: RTCPeerConnection; playerId: string | null; pending: RTCIceCandidateInit[] }

/**
 * Maneja las conexiones. `onSignal` va conectado al WebSocket: se asigna por ref porque el socket se
 * crea antes que este hook (el socket necesita el callback y el hook necesita `send`).
 */
export function useTableVideo(socket: TableSocket, myPlayerId: string | null) {
  const { live, send } = socket;
  const [local, setLocal] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<ReadonlyMap<string, MediaStream>>(new Map());
  const [muteOthers, setMuteOthers] = useState(false);

  const localRef = useRef<MediaStream | null>(null);
  /** Conexiones donde yo transmito (una por espectador) y donde yo miro (una por quien transmite), por id de conexión. */
  const outgoing = useRef(new Map<string, Link>());
  const incoming = useRef(new Map<string, Link>());
  const sendRef = useRef(send);
  sendRef.current = send;
  const me = useRef(myPlayerId);
  me.current = myPlayerId;

  const setRemoteStream = useCallback((playerId: string, stream: MediaStream | null) => {
    setRemote(prev => {
      if (stream ? prev.get(playerId) === stream : !prev.has(playerId)) return prev;
      const next = new Map(prev);
      if (stream) next.set(playerId, stream); else next.delete(playerId);
      return next;
    });
  }, []);

  const closeLink = useCallback((links: Map<string, Link>, peerId: string) => {
    const link = links.get(peerId);
    if (!link) return;
    links.delete(peerId);
    link.pc.ontrack = link.pc.onicecandidate = link.pc.onconnectionstatechange = null;
    link.pc.close();
    if (links === incoming.current && link.playerId) setRemoteStream(link.playerId, null);
  }, [setRemoteStream]);

  const closeAll = useCallback(() => {
    for (const id of [...outgoing.current.keys()]) closeLink(outgoing.current, id);
    for (const id of [...incoming.current.keys()]) closeLink(incoming.current, id);
  }, [closeLink]);

  const newLink = useCallback((links: Map<string, Link>, peerId: string, playerId: string | null): Link => {
    closeLink(links, peerId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: Link = { pc, playerId, pending: [] };
    links.set(peerId, link);
    const dir: IceData['dir'] = links === outgoing.current ? 'out' : 'in';
    pc.onicecandidate = e => {
      if (e.candidate) sendRef.current({ kind: 'ice', to: peerId, data: { dir, candidate: e.candidate.toJSON() } satisfies IceData });
    };
    // Una conexión caída se descarta y ese jugador vuelve a verse con su inicial.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closeLink(links, peerId);
    };
    return link;
  }, [closeLink]);

  /** Mensajes del servidor sobre video. */
  const onSignal = useCallback((msg: ApiRtcServerMessage) => {
    const { from, playerId } = msg;
    if (playerId && playerId === me.current) return; // otra pestaña mía
    void (async () => {
      try {
        switch (msg.kind) {
          case 'start':
            // Aparece alguien transmitiendo: se le pide el video.
            sendRef.current({ kind: 'watch', to: from });
            break;
          case 'stop':
            closeLink(incoming.current, from);
            break;
          case 'watch': {
            const stream = localRef.current;
            if (!stream) break; // ya corté
            const { pc } = newLink(outgoing.current, from, playerId);
            for (const track of stream.getTracks()) pc.addTrack(track, stream);
            await pc.setLocalDescription(await pc.createOffer());
            sendRef.current({ kind: 'offer', to: from, data: pc.localDescription?.toJSON() });
            // Tope de bitrate: con una malla se sube N-1 veces, así que el video tiene que ser liviano.
            for (const sender of pc.getSenders()) {
              if (sender.track?.kind !== 'video') continue;
              const params = sender.getParameters();
              params.encodings = params.encodings?.length ? params.encodings : [{}];
              params.encodings[0]!.maxBitrate = MAX_BITRATE;
              await sender.setParameters(params).catch(() => {});
            }
            break;
          }
          case 'offer': {
            const link = newLink(incoming.current, from, playerId);
            link.pc.ontrack = e => {
              if (playerId) setRemoteStream(playerId, e.streams[0] ?? new MediaStream([e.track]));
            };
            await link.pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
            for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
            await link.pc.setLocalDescription(await link.pc.createAnswer());
            sendRef.current({ kind: 'answer', to: from, data: link.pc.localDescription?.toJSON() });
            break;
          }
          case 'answer': {
            const link = outgoing.current.get(from);
            if (!link || link.pc.signalingState !== 'have-local-offer') break;
            await link.pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
            for (const c of link.pending.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
            break;
          }
          case 'ice': {
            const { dir, candidate } = msg.data as IceData;
            // El candidato que sale de mi conexión de salida ("out") para el otro entra a su conexión de entrada, y al revés.
            const link = (dir === 'out' ? incoming : outgoing).current.get(from);
            if (!link) break;
            if (link.pc.remoteDescription) await link.pc.addIceCandidate(candidate).catch(() => {});
            else link.pending.push(candidate);
            break;
          }
        }
      } catch {
        // Una negociación fallida solo deja a ese jugador sin video; no tiene que romper la mesa.
        if (msg.kind === 'offer') closeLink(incoming.current, from);
        else if (msg.kind === 'watch') closeLink(outgoing.current, from);
      }
    })();
  }, [closeLink, newLink, setRemoteStream]);

  const stop = useCallback(() => {
    const stream = localRef.current;
    localRef.current = null;
    if (stream) {
      sendRef.current({ kind: 'stop' });
      for (const track of stream.getTracks()) track.stop(); // apaga la luz de la cámara y libera el micrófono
    }
    for (const id of [...outgoing.current.keys()]) closeLink(outgoing.current, id);
    setLocal(null);
    setMicOn(false);
  }, [closeLink]);

  const start = useCallback(async (withMic: boolean) => {
    if (!me.current) return;
    setError(null);
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA, audio: withMic });
      if (localRef.current) stop(); // cambio de micrófono: se reinicia la transmisión
      localRef.current = stream;
      // Si el usuario corta desde el navegador (el indicador de cámara), se refleja acá.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (localRef.current === stream) stop(); });
      setLocal(stream);
      setMicOn(withMic);
      sendRef.current({ kind: 'start' });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : '';
      setError(name === 'NotAllowedError' ? 'No diste permiso para usar la cámara.'
        : name === 'NotFoundError' ? 'No se encontró una cámara.'
          : 'No se pudo iniciar la cámara.');
    } finally {
      setStarting(false);
    }
  }, [stop]);

  // Si se corta el WebSocket, el servidor ya avisó que dejé de transmitir y las conexiones quedaron huérfanas:
  // se descartan, y al volver se anuncia otra vez (el servidor informa a su vez quién transmite).
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) {
      if (localRef.current) sendRef.current({ kind: 'start' });
    } else if (wasLive.current) {
      closeAll();
    }
    wasLive.current = live;
  }, [live, closeAll]);

  // Al salir de la mesa o cerrar la pestaña se corta todo.
  useEffect(() => {
    const off = () => { stop(); closeAll(); };
    window.addEventListener('pagehide', off);
    return () => { window.removeEventListener('pagehide', off); off(); };
  }, [stop, closeAll]);

  const state: VideoState = {
    supported: videoSupported(), local, micOn, starting, error, remote, muteOthers, setMuteOthers,
    start, stop, canBroadcast: !!myPlayerId, myPlayerId,
  };
  return { state, onSignal };
}

export function VideoProvider({ state, children }: { state: VideoState; children: ReactNode }) {
  return <VideoContext.Provider value={state}>{children}</VideoContext.Provider>;
}

/** El stream a un <video>. React no tiene prop para `srcObject`. */
export function StreamVideo({ stream, muted, mirrored, className = '' }: {
  stream: MediaStream; muted?: boolean; mirrored?: boolean; className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    // Sin gesto previo el navegador puede negarse a reproducir con sonido: mejor ver el video mudo que no verlo.
    void el.play().catch(() => { el.muted = true; void el.play().catch(() => {}); });
    return () => { el.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={`${className} ${mirrored ? 'video-mirror' : ''}`} autoPlay playsInline muted={muted} aria-hidden="true" />;
}

/** Controles de mi transmisión. */
export function VideoControls() {
  const v = useVideo();
  const [wantMic, setWantMic] = useState(false);
  if (!v || !v.canBroadcast) return null;
  if (!v.supported) {
    return <p className="muted small">Este navegador no permite transmitir video. Hace falta una conexión segura (https) y una cámara.</p>;
  }
  const live = !!v.local;
  return (
    <div className="video-controls" role="group" aria-label="Transmisión de video">
      {live
        ? <Btn variant="danger" onClick={v.stop}>Detener transmisión</Btn>
        : <Btn busy={v.starting} onClick={() => { void v.start(wantMic); }}>Transmitir video</Btn>}
      {/* El audio es opcional y arranca apagado. Cambiarlo con la transmisión en curso la reinicia. */}
      <label className="video-mic">
        <input type="checkbox" checked={live ? v.micOn : wantMic} disabled={v.starting}
          onChange={e => { if (live) void v.start(e.target.checked); else setWantMic(e.target.checked); }} />
        Micrófono
      </label>
      <label className="video-mic">
        <input type="checkbox" checked={v.muteOthers} onChange={e => v.setMuteOthers(e.target.checked)} />
        Silenciar a los demás
      </label>
      {v.error && <div className="notice notice-err" role="alert">{v.error}</div>}
    </div>
  );
}
