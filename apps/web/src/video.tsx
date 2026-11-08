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

/** Se puede transmitir si el navegador tiene WebRTC y acceso a cámara o micrófono; el contexto seguro (https/localhost) lo exige. */
export const videoSupported = () =>
  typeof RTCPeerConnection !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

/** De qué lado de la conexión sale un candidato ICE; sirve para que el otro extremo lo asigne a la conexión correcta. */
type IceData = { dir: 'out' | 'in'; candidate: RTCIceCandidateInit };

const UNBLOCK_HINT = 'Habilitalo desde el candado de la barra de direcciones y volvé a intentar.';

/** Estado del permiso en el navegador; null si no lo informa (Safari, Firefox para cámara y micrófono). */
async function permissionState(name: 'camera' | 'microphone'): Promise<PermissionState | null> {
  try { return (await navigator.permissions.query({ name: name as PermissionName })).state; } catch { return null; }
}

/** ¿Falló solo el micrófono? Es así si la cámara ya quedó habilitada y el micrófono no. */
async function onlyMicBlocked(e: unknown): Promise<boolean> {
  if (!(e instanceof DOMException) || e.name !== 'NotAllowedError') return false;
  const [camera, mic] = await Promise.all([permissionState('camera'), permissionState('microphone')]);
  return camera === 'granted' && mic === 'denied';
}

/** Qué se pidió al navegador: cámara, micrófono o los dos. */
interface MediaWanted { camera: boolean; mic: boolean }

/** Mensaje para el usuario según por qué falló getUserMedia. */
async function describeMediaError(e: unknown, want: MediaWanted): Promise<string> {
  const name = e instanceof DOMException ? e.name : '';
  const what = want.camera && want.mic ? 'la cámara y el micrófono' : want.camera ? 'la cámara' : 'el micrófono';
  if (name === 'NotAllowedError') {
    const [camera, mic] = await Promise.all([want.camera ? permissionState('camera') : null, want.mic ? permissionState('microphone') : null]);
    // "denied" sin diálogo previo: el sitio quedó bloqueado antes y el navegador ya no vuelve a preguntar.
    if (camera === 'denied') return 'La cámara está bloqueada para este sitio. ' + UNBLOCK_HINT;
    if (mic === 'denied') return 'El micrófono está bloqueado para este sitio. ' + UNBLOCK_HINT;
    return `No diste permiso para usar ${what}. Tocá "${want.camera ? 'Transmitir video' : 'Transmitir audio'}" para que el navegador pregunte de nuevo.`;
  }
  if (name === 'NotFoundError') return want.camera && want.mic ? 'No se encontró una cámara o un micrófono.' : want.camera ? 'No se encontró una cámara.' : 'No se encontró un micrófono.';
  if (name === 'NotReadableError') return want.camera ? 'La cámara está en uso por otra aplicación o bloqueada por el sistema.' : 'El micrófono está en uso por otra aplicación o bloqueado por el sistema.';
  return want.camera ? 'No se pudo iniciar la cámara.' : 'No se pudo iniciar el micrófono.';
}

interface VideoState {
  supported: boolean;
  /** Mi transmisión: null si no estoy transmitiendo. */
  local: MediaStream | null;
  /** Qué estoy transmitiendo: cámara, micrófono o los dos (al menos uno mientras transmito). */
  camOn: boolean;
  micOn: boolean;
  starting: boolean;
  error: string | null;
  /** Video de los demás, por jugador. */
  remote: ReadonlyMap<string, MediaStream>;
  /** Silencia el audio que llega de los demás (solo en este dispositivo). */
  muteOthers: boolean;
  setMuteOthers: (v: boolean) => void;
  /** Con cámara, micrófono o los dos (al menos uno). Si ya transmitía, reinicia la transmisión con la nueva opción. */
  start: (want: MediaWanted) => Promise<void>;
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
  const [camOn, setCamOn] = useState(false);
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
    setCamOn(false);
    setMicOn(false);
  }, [closeLink]);

  const start = useCallback(async (want: MediaWanted) => {
    if (!me.current || (!want.camera && !want.mic)) return;
    setError(null);
    setStarting(true);
    try {
      // Pide el permiso en este momento: cámara y/o micrófono en el mismo diálogo del navegador.
      let stream: MediaStream;
      let micGranted = want.mic;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: want.camera ? CAMERA : false, audio: want.mic });
      } catch (e) {
        // Sin permiso de micrófono pero con cámara habilitada: se transmite solo el video y se avisa.
        if (!(want.camera && want.mic) || !(await onlyMicBlocked(e))) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA, audio: false });
        micGranted = false;
        setError('Sin permiso para el micrófono: se transmite solo el video. ' + UNBLOCK_HINT);
      }
      if (localRef.current) stop(); // cambio de cámara o micrófono: se reinicia la transmisión
      localRef.current = stream;
      // Si el usuario corta desde el navegador (el indicador de cámara o micrófono), se refleja acá.
      (stream.getVideoTracks()[0] ?? stream.getAudioTracks()[0])?.addEventListener('ended', () => { if (localRef.current === stream) stop(); });
      setLocal(stream);
      setCamOn(want.camera);
      setMicOn(micGranted);
      sendRef.current({ kind: 'start' });
    } catch (e) {
      setError(await describeMediaError(e, want));
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
    supported: videoSupported(), local, camOn, micOn, starting, error, remote, muteOthers, setMuteOthers,
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

/** Controles de mi transmisión: cámara y micrófono se eligen por separado (se puede transmitir solo el audio). */
export function VideoControls() {
  const v = useVideo();
  const [wantCam, setWantCam] = useState(true);
  const [wantMic, setWantMic] = useState(false);
  if (!v || !v.canBroadcast) return null;
  if (!v.supported) {
    return <p className="muted small">Este navegador no permite transmitir video ni audio. Hace falta una conexión segura (https) y una cámara o un micrófono.</p>;
  }
  const live = !!v.local;
  const cam = live ? v.camOn : wantCam;
  const mic = live ? v.micOn : wantMic;
  /** Siempre queda algo para transmitir: si se apaga lo último, se enciende lo otro. Con la transmisión en curso, se reinicia. */
  const change = (camera: boolean, microphone: boolean) => {
    if (!camera && !microphone) { if (cam) microphone = true; else camera = true; }
    if (live) void v.start({ camera, mic: microphone });
    else { setWantCam(camera); setWantMic(microphone); }
  };
  return (
    <div className="video-controls" role="group" aria-label="Transmisión de video">
      {live
        ? <Btn variant="danger" onClick={v.stop}>Detener transmisión</Btn>
        : <Btn busy={v.starting} onClick={() => { void v.start({ camera: wantCam, mic: wantMic }); }}>{wantCam ? 'Transmitir video' : 'Transmitir audio'}</Btn>}
      {/* La cámara arranca encendida y el micrófono apagado. Cambiarlos con la transmisión en curso la reinicia. */}
      <label className="video-mic">
        <input type="checkbox" aria-label="Cámara" checked={cam} disabled={v.starting} onChange={e => change(e.target.checked, mic)} />
        Cámara
      </label>
      <label className="video-mic">
        <input type="checkbox" aria-label="Micrófono" checked={mic} disabled={v.starting} onChange={e => change(cam, e.target.checked)} />
        Micrófono
      </label>
      <label className="video-mic">
        <input type="checkbox" aria-label="Silenciar a los demás" checked={v.muteOthers} onChange={e => v.setMuteOthers(e.target.checked)} />
        Silenciar a los demás
      </label>
      {v.error && <div className="notice notice-err" role="alert">{v.error}</div>}
    </div>
  );
}

/**
 * En la mesa, el video va en un botón de cámara (con un punto rojo mientras transmitís) que abre un panel con los controles:
 * así no ocupa lugar en la zona de las acciones.
 */
export function VideoMenu() {
  const v = useVideo();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  // Un error al arrancar la cámara se muestra en el panel: se abre solo para que se vea.
  useEffect(() => { if (v?.error) setOpen(true); }, [v?.error]);
  if (!v || !v.canBroadcast) return null;
  const live = !!v.local;
  return (
    <div className="video-menu" ref={ref}>
      <button type="button" className={`tool-btn${live ? ' tool-btn-live' : ''}`} aria-label={live ? 'Video (transmitiendo)' : 'Video'}
        aria-expanded={open} aria-controls="video-panel" onClick={() => setOpen(o => !o)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="2" y="6" width="14" height="12" rx="2" /><path d="M16 10l6-3v10l-6-3z" />
        </svg>
      </button>
      {open && <div id="video-panel" className="video-panel"><VideoControls /></div>}
    </div>
  );
}
