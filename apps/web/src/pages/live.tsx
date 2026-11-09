import type { ApiEmojiServerMessage, ApiLiveMode, ApiLivePhotoMeta, ApiLiveStreet, ApiLiveView, ApiRtcServerMessage } from '@pokercontrol/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiRequestError, api, apiBlob } from '../api';
import { EmojiFab, EmojiLayer } from '../components/emoji';
import { Avatar, Btn, Emoji, Empty, Loading, QueryError, useAction, useFeedback } from '../components/ui';
import { useGroup } from '../context';
import { ShotCamera, type ShotStep } from '../components/ShotCamera';
import { shareText } from '../share';
import { useTablePrefs } from '../tablePrefs';
import { useTableSocket } from '../useTableSocket';
import { StreamVideo, TABLE_KEY, VideoProvider, useTableVideo } from '../video';

type Member = ApiLiveView['members'][number];
const STREETS: { id: ApiLiveStreet; label: string }[] = [{ id: 'flop', label: 'Flop' }, { id: 'turn', label: 'Turn' }, { id: 'river', label: 'River' }];

/** Una foto protegida: se baja con el token en un header y se muestra como blob (sin tokens en la URL). */
function PhotoImg({ code, photo, alt, className }: { code: string; photo: ApiLivePhotoMeta; alt: string; className?: string }) {
  const { path } = useGroup();
  // `path` cambia en cada render: se guarda en una ref para que la foto no se vuelva a bajar cada vez.
  const pathRef = useRef(path);
  pathRef.current = path;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    apiBlob(pathRef.current(`/live/${code}/photos/${photo.id}`))
      .then(blob => { if (!revoked) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); } })
      .catch(() => { if (!revoked) setFailed(true); });
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photo.id, code]);
  if (failed) return <p className="muted small">No se pudo cargar la foto.</p>;
  if (!url) return <div className={`live-photo-loading ${className ?? ''}`} role="status" aria-label="Cargando la foto" />;
  return <img src={url} alt={alt} className={className} />;
}

/** Tus cartas: ocultas hasta que las tocás, así no las ve quien tengas cerca; se vuelven a tapar solas. */
function MyCards({ code, photo }: { code: string; photo: ApiLivePhotoMeta | undefined }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { setShown(false); }, [photo?.id]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), 10_000);
    return () => clearTimeout(t);
  }, [shown]);
  if (!photo) return <p className="muted small">Todavía no te mandaron tus cartas en esta mano.</p>;
  return (
    <div className="live-mycards">
      {shown
        ? <PhotoImg code={code} photo={photo} alt="Tus cartas" className="live-photo" />
        : <div className="live-photo live-photo-hidden" aria-hidden="true"><Emoji>🂠</Emoji></div>}
      <Btn variant="ghost" block onClick={() => setShown(s => !s)} aria-pressed={shown}>{shown ? 'Tapar mis cartas' : 'Ver mis cartas'}</Btn>
    </div>
  );
}

/** La mesa «como en la mesa online»: un paño con el flop, el turn y el river, y tus cartas debajo. */
function Felt({ code, view }: { code: string; view: ApiLiveView }) {
  const myCards = view.myCards[view.myCards.length - 1];
  return (
    <section className="live-felt" aria-label="Mesa" data-testid="live-felt">
      <div className="live-felt-board">
        {STREETS.map(st => {
          const photo = view.board.find(p => p.street === st.id);
          return (
            <figure key={st.id} className="live-slot" data-testid={`slot-${st.id}`}>
              {photo
                ? <PhotoImg code={code} photo={photo} alt={`${st.label} de la mesa`} className="live-slot-photo" />
                : <div className="live-slot-empty" aria-hidden="true">·</div>}
              <figcaption>{st.label}{photo ? '' : ' (todavía no)'}</figcaption>
            </figure>
          );
        })}
      </div>
      {view.me?.mode === 'remote' && <MyCards code={code} photo={myCards} />}
    </section>
  );
}

/** Una carita (video o inicial con el audio sonando) de alguien de la sala. */
function Face({ m, stream, muted, big }: { m: Member; stream: MediaStream | undefined; muted: boolean; big?: boolean }) {
  return (
    <div className={`live-face${big ? ' live-face-big' : ''}`} data-testid={`face-${m.name}`}>
      {stream && stream.getVideoTracks().length > 0
        ? <StreamVideo stream={stream} className="live-face-video" muted={muted} />
        : (
          <span className="live-face-avatar">
            <Avatar name={m.name} large />
            {stream && <StreamVideo stream={stream} className="pseat-audio" muted={muted} />}
          </span>
        )}
      <span className="live-face-name"><span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" /> {m.name}{m.mode === 'table' ? ' (en la mesa)' : ''}{m.online ? '' : ' (sin conexión)'}</span>
    </div>
  );
}

/** Pantalla de entrada: ¿estás en la mesa o jugás a distancia? */
function ChooseMode({ onChoose }: { onChoose: (mode: ApiLiveMode) => void }) {
  return (
    <section className="card stack" aria-label="¿Dónde estás?">
      <h2>¿Dónde estás?</h2>
      <Btn block onClick={() => onChoose('remote')}><Emoji>📱</Emoji> Juego a distancia</Btn>
      <p className="xs muted" style={{ marginTop: -4 }}>Recibís tus cartas y las de la mesa, y se te oye siempre. Las apuestas se dicen en voz alta.</p>
      <Btn block variant="ghost" onClick={() => onChoose('table')}><Emoji>🃏</Emoji> Estoy en la mesa</Btn>
      <p className="xs muted" style={{ marginTop: -4 }}>Cargás las fotos de las cartas y podés transmitir la mesa con la cámara.</p>
    </section>
  );
}

/**
 * La conexión remota de una partida presencial. Quien juega a distancia ve «la mesa» con sus cartas y las comunitarias,
 * escucha la mesa y, si quiere, ve la transmisión; quien está en la mesa carga las fotos y puede transmitir con la cámara
 * (de a uno). Se usa desde el link de invitación, desde la partida y desde «Mesa».
 */
export function LiveRoom({ code, screenMode = false }: { code: string; screenMode?: boolean }) {
  const { group, path, key } = useGroup();
  const qc = useQueryClient();
  const { notify, confirm } = useFeedback();
  const { busy, run } = useAction();
  const [prefs] = useTablePrefs();
  const queryKey = key('live', code);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ApiLiveMode | null>(screenMode ? 'table' : null);
  const [cameraOn, setCameraOn] = useState(true);
  // La cámara de la app para cargar las cartas (null = cerrada); `step` es el paso con el que se abre.
  const [shot, setShot] = useState<{ step: string } | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => api<ApiLiveView>(path(`/live/${code}`)),
    refetchInterval: 20_000,
    retry: false,
  });
  const view = query.data;
  const mode: ApiLiveMode | null = chosen ?? view?.me?.mode ?? null;

  // Entrar a la sala (con el modo elegido) y renovar la presencia cada ~20 s.
  useEffect(() => {
    if (!mode) return;
    let stopped = false;
    const join = async () => {
      try {
        const v = await api<ApiLiveView>(path(`/live/${code}/join`), { method: 'POST', body: { mode } });
        if (!stopped) { qc.setQueryData(queryKey, v); setJoinError(null); }
      } catch (e) {
        if (!stopped && e instanceof ApiRequestError) setJoinError(e.code);
      }
    };
    void join();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void join(); }, 20_000);
    return () => { stopped = true; clearInterval(id); };
  }, [code, group.id, mode]);

  const signal = useRef<(m: ApiRtcServerMessage) => void>(() => {});
  const busyHandler = useRef<() => void>(() => {});
  const emojiHandler = useRef<(m: ApiEmojiServerMessage) => void>(() => {});
  const socket = useTableSocket(group.id, () => { void qc.invalidateQueries({ queryKey }); }, m => signal.current(m), m => emojiHandler.current(m), {
    room: view?.id, enabled: !!view?.me && view.status === 'open', onBusy: () => busyHandler.current(),
  });
  // La transmisión de la mesa se escucha siempre; el video, solo si se elige verlo.
  const video = useTableVideo(socket, group.playerId, { viewTableByDefault: false });
  signal.current = video.onSignal;
  busyHandler.current = video.onBusy;
  const state = video.state;

  // Quien juega a distancia habla siempre: el micrófono se prende al entrar y no tiene botón de apagado.
  const startedVoice = useRef(false);
  useEffect(() => {
    if (mode !== 'remote' || !view?.me?.playerId || !socket.live || startedVoice.current) return;
    startedVoice.current = true;
    void state.start({ camera: cameraOn, mic: true });
  }, [mode, view?.me?.playerId, socket.live]);

  if (query.isLoading) return <Loading />;
  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return <Empty icon="🔍" title="Sala no encontrada"><p>Revisá el link o pedile uno nuevo a quien lo compartió.</p></Empty>;
  }
  if (query.error || !view) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  if (view.status === 'closed') {
    return <Empty icon="🏁" title="La conexión remota terminó"><p>La partida se cerró. <Link to={`/sessions/${view.sessionId}`}>Ver la partida</Link></p></Empty>;
  }
  if (joinError === 'no_player') {
    return <Empty icon="🙋" title="Elegí tu jugador"><p>Para entrar tenés que elegir quién sos en el grupo. <Link to="/">Elegir mi jugador</Link></p></Empty>;
  }
  if (!mode) return <><h1 style={{ marginBottom: 12 }}>Conexión remota · {view.sessionName}</h1><ChooseMode onChoose={setChosen} /></>;

  const me = view.me;
  const others = view.members.filter(m => m.userId !== me?.userId);
  const remotes = view.members.filter(m => m.mode === 'remote' && m.userId !== me?.userId);
  const link = `${window.location.origin}/live/${view.code}`;
  const tableStream = state.remote.get(TABLE_KEY);
  const tableHasVideo = !!tableStream && tableStream.getVideoTracks().length > 0;
  const broadcaster = state.tableBy ? view.members.find(m => m.playerId === state.tableBy?.playerId) : null;
  const iTransmit = state.source === 'table' && !!state.local;

  const post = (suffix: string, body?: unknown) => run(async () => {
    const next = await api<ApiLiveView>(path(`/live/${view.code}/${suffix}`), { method: 'POST', body });
    qc.setQueryData(queryKey, next);
  });
  const sendPhoto = async (body: { kind: 'board' | 'hole'; street?: ApiLiveStreet; playerId?: string; image: string }) => {
    await api(path(`/live/${view.code}/photos`), { method: 'POST', body });
    await qc.invalidateQueries({ queryKey });
  };
  const newHand = async () => {
    const ok = await confirm({ title: 'Nueva mano', message: 'Se borran las fotos de la mano anterior para todos.', confirmLabel: 'Nueva mano' });
    if (ok) void post('new-hand');
  };
  const closeRoom = async () => {
    const ok = await confirm({ title: 'Cerrar la conexión remota', message: 'Los remotos se desconectan y se borran todas las fotos. La partida sigue abierta.', danger: true, confirmLabel: 'Cerrar' });
    if (ok) void post('close');
  };
  /** Los pasos de la carga: cartas de cada remoto y después flop, turn y river. */
  const steps: ShotStep[] = [
    ...remotes.map(m => ({ id: `hole:${m.playerId}`, label: `Cartas de ${m.name}`, done: !!view.sent[m.playerId] })),
    ...STREETS.map(st => ({ id: `board:${st.id}`, label: st.label, done: view.board.some(p => p.street === st.id) })),
  ];
  const onShot = async (stepId: string, image: string) => {
    const [kind, value] = stepId.split(':');
    await sendPhoto(kind === 'hole'
      ? { kind: 'hole', playerId: value, image }
      : { kind: 'board', street: value as ApiLiveStreet, image });
  };
  const switchMode = (next: ApiLiveMode) => {
    if (next === 'table' && state.local && state.source === 'face') state.stop();
    startedVoice.current = false;
    setChosen(next);
  };
  const toggleCamera = (on: boolean) => { setCameraOn(on); void state.start({ camera: on, mic: true }); };

  return (
    <VideoProvider state={state}>
      <Link className="breadcrumb" to={`/sessions/${view.sessionId}`}>← Partida</Link>
      <h1 style={{ marginBottom: 4 }}>{screenMode ? 'Pantalla de la mesa' : mode === 'remote' ? 'Jugás a distancia' : 'En la mesa'} · {view.sessionName}</h1>
      <p className="small muted" style={{ marginBottom: 12 }}>
        <span role="img" aria-label={socket.live ? 'En vivo' : 'Sin conexión en vivo'}>{socket.live ? '🟢' : '🟠'}</span> Mano {view.handNo}
        {' · '}<button type="button" className="link-btn" onClick={() => switchMode(mode === 'remote' ? 'table' : 'remote')}>
          {mode === 'remote' ? 'Estoy en la mesa' : 'Juego a distancia'}
        </button>
      </p>

      {/* La transmisión de la mesa: el audio llega siempre; el video, si se elige verlo. */}
      {tableStream && !tableHasVideo && <StreamVideo stream={tableStream} className="pseat-audio" muted={false} />}
      <section className="card live-stage" aria-label="Transmisión de la mesa">
        {(mode === 'remote' && state.viewTable && tableHasVideo) || screenMode || iTransmit
          ? (iTransmit && state.local
            ? <StreamVideo stream={state.local} className="live-table-video" muted />
            : tableStream && tableHasVideo
              ? <StreamVideo stream={tableStream} className="live-table-video" muted={false} />
              : <div className="live-table-empty"><Emoji>📹</Emoji><p className="muted small">Esperando la transmisión de la mesa…</p></div>)
          : (
            <div className="live-table-empty">
              <Emoji>📹</Emoji>
              <p className="small">{state.tableBy ? `${broadcaster?.name ?? 'Alguien'} transmite la mesa.` : 'Nadie transmite la mesa todavía.'} {mode === 'remote' && tableStream ? 'La escuchás en vivo.' : ''}</p>
              {mode === 'remote' && state.tableBy && (
                <Btn variant="ghost" aria-pressed={state.viewTable} onClick={() => state.setViewTable(true)}>Ver la transmisión</Btn>
              )}
            </div>
          )}
        {mode === 'remote' && state.viewTable && tableHasVideo && (
          <Btn variant="ghost" block onClick={() => state.setViewTable(false)}>Dejar de ver la transmisión (sigo escuchando)</Btn>
        )}
      </section>

      {mode === 'remote' && !screenMode && (
        <>
          <Felt code={view.code} view={view} />
          <h2 className="section-title">Tu audio y tu cámara</h2>
          <div className="card stack">
            <p className="small"><span role="img" aria-label="Micrófono">🎙️</span> {state.local ? 'Tu micrófono está activo: la mesa te escucha siempre.' : 'Activando tu micrófono…'}</p>
            {!state.local && !state.starting && (
              <Btn onClick={() => { void state.start({ camera: cameraOn, mic: true }); }}>Activar micrófono</Btn>
            )}
            <label className="check-row">
              <span className="grow">Mostrar mi cámara</span>
              <input type="checkbox" role="switch" aria-label="Mostrar mi cámara" checked={cameraOn} disabled={state.starting} onChange={e => toggleCamera(e.target.checked)} />
            </label>
            {state.error && <div className="notice notice-err" role="alert">{state.error}</div>}
          </div>
        </>
      )}

      {mode === 'table' && !screenMode && (
        <>
          <h2 className="section-title">Cargar las cartas</h2>
          <div className="card stack" aria-label="Cargar las cartas">
            <p className="small muted">Primero las cartas de cada jugador remoto (las ve solo él) y después el flop, el turn y el river, a medida que salen. La foto se envía al sacarla.</p>
            <Btn busy={busy} onClick={() => setShot({ step: steps.find(x => !x.done)?.id ?? steps[0]?.id ?? 'board:flop' })} data-testid="open-shot"><Emoji>📷</Emoji> Abrir la cámara</Btn>
            <div className="live-steps" role="group" aria-label="Estado de las fotos">
              {steps.map(x => (
                <Btn key={x.id} variant={x.done ? 'ghost' : 'primary'} onClick={() => setShot({ step: x.id })} data-testid={`step-${x.id}`}>{x.done ? '✅ ' : ''}{x.label}</Btn>
              ))}
            </div>
            <Btn variant="ghost" busy={busy} onClick={() => { void newHand(); }}>Nueva mano (borra las fotos)</Btn>
          </div>
        </>
      )}

      {mode === 'table' && (
        <>
          <h2 className="section-title">Transmitir la mesa</h2>
          <div className="card stack" aria-label="Transmitir la mesa">
            <p className="small muted">De la mesa transmite una sola persona, con audio. Los remotos eligen si ven el video; el audio lo escuchan siempre.</p>
            {iTransmit
              ? (
                <>
                  <p className="small"><span role="img" aria-label="En vivo">🔴</span> Estás transmitiendo con la cámara {state.tableFacing === 'user' ? 'frontal' : 'trasera'}.</p>
                  <div className="row">
                    <Btn variant="ghost" className="grow" busy={state.starting}
                      onClick={() => { void state.startTable(state.tableFacing === 'user' ? 'environment' : 'user'); }}>Cambiar de cámara</Btn>
                    <Btn variant="danger" className="grow" onClick={state.stop}>Detener</Btn>
                  </div>
                </>
              )
              : state.tableBy
                ? <p className="small" data-testid="table-busy">{broadcaster?.name ?? 'Otra persona'} ya está transmitiendo la mesa.</p>
                : (
                  <div className="row">
                    <Btn className="grow" busy={state.starting} onClick={() => { void state.startTable('environment'); }}><Emoji>🎥</Emoji> Cámara trasera</Btn>
                    <Btn variant="ghost" className="grow" busy={state.starting} onClick={() => { void state.startTable('user'); }}>Cámara frontal</Btn>
                  </div>
                )}
            {state.error && <div className="notice notice-err" role="alert">{state.error}</div>}
          </div>
        </>
      )}

      {others.length > 0 && (
        <>
          <h2 className="section-title">{mode === 'table' ? 'Jugadores a distancia' : 'En la sala'}</h2>
          <section aria-label="Jugadores conectados" className={`live-faces${screenMode ? ' live-faces-big' : ''}`}>
            {others.filter(m => mode === 'table' ? m.mode === 'remote' : true).map(m => (
              <Face key={m.playerId} m={m} stream={state.remote.get(m.playerId)} muted={state.muteOthers} big={screenMode} />
            ))}
            {screenMode && (
              <Btn variant="ghost" onClick={() => document.querySelectorAll('video').forEach(v => { v.muted = false; void v.play().catch(() => {}); })}>
                <Emoji>🔊</Emoji> Activar sonido
              </Btn>
            )}
          </section>
        </>
      )}

      {view.canManage && !screenMode && (
        <>
          <h2 className="section-title">Invitar</h2>
          <div className="card stack">
            <div className="row">
              <Btn variant="ghost" className="grow" onClick={() => { void shareText(`Sumate a la partida a distancia: ${link}`, notify); }}><Emoji>📤</Emoji> Compartir link</Btn>
              <Btn variant="ghost" className="grow" onClick={() => { void navigator.clipboard?.writeText(link).then(() => notify('Link copiado.')).catch(() => notify(link)); }}>Copiar</Btn>
            </div>
            <p className="xs muted">Pantalla para la mesa (tablet o celular fijo): <a href={`${link}?mesa`}>{`${link}?mesa`}</a></p>
            <Btn variant="danger" busy={busy} onClick={() => { void closeRoom(); }}>Cerrar la conexión remota</Btn>
          </div>
        </>
      )}

      {shot && mode === 'table' && <ShotCamera steps={steps} initial={shot.step} onShot={onShot} onClose={() => setShot(null)} />}
      <EmojiLayer handler={emojiHandler} enabled={prefs.emojis} sound={prefs.emojiSound} />
      {prefs.emojis && me && !screenMode && <EmojiFab placement="page" live={socket.live} onSend={socket.sendEmoji} />}
    </VideoProvider>
  );
}

/** Ruta /live/:code (link de invitación): `?mesa` la deja como pantalla de la mesa. */
export function LivePage() {
  const { code = '' } = useParams();
  const [search] = useSearchParams();
  return <LiveRoom code={code} screenMode={search.has('mesa')} />;
}
