import type { ApiEmojiServerMessage, ApiLivePhotoMeta, ApiLiveView, ApiRtcServerMessage } from '@pokercontrol/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiRequestError, api, apiBlob } from '../api';
import { EmojiFab, EmojiLayer } from '../components/emoji';
import { Avatar, Btn, Emoji, Empty, Loading, QueryError, useAction, useFeedback } from '../components/ui';
import { useGroup } from '../context';
import { resizeToJpeg } from '../photo';
import { shareText } from '../share';
import { useTablePrefs } from '../tablePrefs';
import { useTableSocket } from '../useTableSocket';
import { StreamVideo, TABLE_KEY, VideoControls, VideoProvider, useTableVideo } from '../video';

type Member = ApiLiveView['members'][number];

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

function Board({ code, photos }: { code: string; photos: ApiLivePhotoMeta[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  if (photos.length === 0) return <p className="muted small">Todavía no mandaron fotos de la mesa en esta mano.</p>;
  const latest = photos[photos.length - 1];
  const current = photos.find(p => p.id === picked) ?? latest;
  return (
    <div>
      <PhotoImg code={code} photo={current} alt="Cartas de la mesa" className="live-photo" />
      {photos.length > 1 && (
        <div className="live-thumbs" role="group" aria-label="Fotos de la mesa de esta mano">
          {photos.map((p, i) => (
            <Btn key={p.id} variant="ghost" aria-pressed={p.id === current.id} onClick={() => setPicked(p.id)}>{i === photos.length - 1 ? `Última (${i + 1})` : String(i + 1)}</Btn>
          ))}
        </div>
      )}
    </div>
  );
}

/** Botón que abre la cámara del celular, reduce la foto y la sube. */
function PhotoButton({ label, busy, onPhoto, primary }: { label: string; busy: boolean; onPhoto: (base64: string) => Promise<void>; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const { notify } = useFeedback();
  const [working, setWorking] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setWorking(true);
    try {
      await onPhoto(await resizeToJpeg(file));
    } catch (e) {
      notify(e instanceof ApiRequestError ? e.message : 'No se pudo mandar la foto.');
    } finally {
      setWorking(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true"
        data-testid="photo-input" onChange={e => { void pick(e.target.files?.[0]); }} />
      <Btn variant={primary ? 'primary' : 'ghost'} busy={busy || working} onClick={() => input.current?.click()}><Emoji>📷</Emoji> {label}</Btn>
    </>
  );
}

export function LivePage() {
  const { code = '' } = useParams();
  const [search] = useSearchParams();
  const screenMode = search.has('mesa');
  const { group, path, key } = useGroup();
  const qc = useQueryClient();
  const { notify, confirm } = useFeedback();
  const { busy, run } = useAction();
  const [prefs] = useTablePrefs();
  const queryKey = key('live', code);
  const [joinError, setJoinError] = useState<string | null>(null);

  const query = useQuery({
    queryKey,
    queryFn: () => api<ApiLiveView>(path(`/live/${code}`)),
    refetchInterval: 20_000,
    retry: false,
  });

  // Entrar a la sala y renovar la presencia cada ~20 s.
  useEffect(() => {
    let stopped = false;
    const join = async () => {
      try {
        const v = await api<ApiLiveView>(path(`/live/${code}/join`), { method: 'POST' });
        if (!stopped) { qc.setQueryData(queryKey, v); setJoinError(null); }
      } catch (e) {
        if (!stopped && e instanceof ApiRequestError) setJoinError(e.code);
      }
    };
    void join();
    const id = setInterval(() => { if (document.visibilityState === 'visible') void join(); }, 20_000);
    return () => { stopped = true; clearInterval(id); };
  }, [code, group.id]);

  const view = query.data;
  const signal = useRef<(m: ApiRtcServerMessage) => void>(() => {});
  const emojiHandler = useRef<(m: ApiEmojiServerMessage) => void>(() => {});
  const socket = useTableSocket(group.id, () => { void qc.invalidateQueries({ queryKey }); }, m => signal.current(m), m => emojiHandler.current(m), {
    room: view?.id, enabled: !!view?.me && view.status === 'open',
  });
  const video = useTableVideo(socket, group.playerId);
  signal.current = video.onSignal;

  if (query.isLoading) return <Loading />;
  if (query.error instanceof ApiRequestError && query.error.status === 404) {
    return <Empty icon="🔍" title="Sala no encontrada"><p>Revisá el link o pedile uno nuevo a quien armó la sala.</p></Empty>;
  }
  if (query.error || !view) return <QueryError error={query.error} onRetry={() => { void query.refetch(); }} />;
  if (view.status === 'closed') {
    return <Empty icon="🏁" title="La sala se cerró"><p>La partida terminó. <Link to={`/sessions/${view.sessionId}`}>Ver la partida</Link></p></Empty>;
  }
  if (joinError === 'no_player') {
    return (
      <Empty icon="🙋" title="Elegí tu jugador">
        <p>Para entrar a la sala tenés que elegir quién sos en el grupo. <Link to="/">Elegir mi jugador</Link></p>
      </Empty>
    );
  }

  const me = view.me;
  // Todos los que entraron a la sala pueden mandar fotos, pasar de mano y transmitir la mesa.
  const canSend = !!me;
  const state = video.state;
  const tableStream = state.remote.get(TABLE_KEY) ?? (state.source === 'table' ? state.local : null);
  const others = view.members.filter(m => m.userId !== me?.userId);
  const remotes = others;
  const link = `${window.location.origin}/live/${view.code}`;

  const post = (suffix: string, body?: unknown) => run(async () => {
    const next = await api<ApiLiveView>(path(`/live/${view.code}/${suffix}`), { method: 'POST', body });
    qc.setQueryData(queryKey, next);
  });
  const sendPhoto = async (body: { kind: 'board' | 'hole'; playerId?: string; image: string }) => {
    await api(path(`/live/${view.code}/photos`), { method: 'POST', body });
    await qc.invalidateQueries({ queryKey });
  };
  const newHand = async () => {
    const ok = await confirm({ title: 'Nueva mano', message: 'Se borran las fotos de la mano anterior para todos.', confirmLabel: 'Nueva mano' });
    if (ok) void post('new-hand');
  };
  const closeRoom = async () => {
    const ok = await confirm({ title: 'Cerrar la sala', message: 'Los remotos se desconectan y se borran todas las fotos. La partida sigue abierta.', danger: true, confirmLabel: 'Cerrar sala' });
    if (ok) void post('close');
  };
  const face = (m: Member) => {
    const stream = state.remote.get(m.playerId);
    return (
      <div key={m.playerId} className={`live-face${screenMode ? ' live-face-big' : ''}`} data-player={m.playerId} data-testid={`face-${m.name}`}>
        {stream && stream.getVideoTracks().length > 0
          ? <StreamVideo stream={stream} className="live-face-video" muted={state.muteOthers} />
          : <span className="live-face-avatar">
            <Avatar name={m.name} large />
            {stream && <StreamVideo stream={stream} className="pseat-audio" muted={state.muteOthers} />}
          </span>}
        <span className="live-face-name"><span className={`dot ${m.online ? 'dot-on' : 'dot-off'}`} aria-hidden="true" /> {m.name}{m.online ? '' : ' (sin conexión)'}</span>
      </div>
    );
  };

  return (
    <VideoProvider state={state}>
      <Link className="breadcrumb" to={`/sessions/${view.sessionId}`}>← Partida</Link>
      <h1 style={{ marginBottom: 4 }}>{screenMode ? 'Pantalla de la mesa' : 'Sala remota'} · {view.sessionName}</h1>
      <p className="small muted" style={{ marginBottom: 12 }}>
        <span role="img" aria-label={socket.live ? 'En vivo' : 'Sin conexión en vivo'}>{socket.live ? '🟢' : '🟠'}</span> Mano {view.handNo}
        {!screenMode && me && ' · Las apuestas se dicen por voz.'}
      </p>

      <section className="card live-stage" aria-label="Video de la mesa">
        {tableStream
          ? <StreamVideo stream={tableStream} className="live-table-video" muted={state.source === 'table' || state.muteOthers} />
          : <div className="live-table-empty"><Emoji>📹</Emoji><p className="muted small">Esperando la cámara de la mesa…</p></div>}
      </section>

      {screenMode ? (
        <section aria-label="Remotos" className="live-faces live-faces-big">
          {remotes.length === 0 ? <p className="muted">Todavía no entró ningún jugador remoto.</p> : remotes.map(face)}
          <Btn variant="ghost" onClick={() => document.querySelectorAll('video').forEach(v => { v.muted = false; void v.play().catch(() => {}); })}>
            <Emoji>🔊</Emoji> Activar sonido
          </Btn>
        </section>
      ) : (
        <>
          {others.length > 0 && <section aria-label="Jugadores conectados" className="live-faces">{others.map(face)}</section>}
          <h2 className="section-title">Mesa</h2>
          <div className="card"><Board code={view.code} photos={view.board} /></div>
          {me?.playerId && (
            <>
              <h2 className="section-title">Tus cartas</h2>
              <div className="card"><MyCards code={view.code} photo={view.myCards[view.myCards.length - 1]} /></div>
            </>
          )}
        </>
      )}

      {me?.playerId && (
        <>
          <h2 className="section-title">Tu cámara y micrófono</h2>
          <div className="card"><VideoControls /></div>
        </>
      )}

      {canSend && (
        <>
          <h2 className="section-title">Compartir fotos y video</h2>
          <div className="card stack" aria-label="Operador">
            <p className="small muted">Cualquiera puede mandar la foto de la mesa, la de las cartas de un jugador (la recibe solo él) o la cámara de la mesa. Sacá las fotos con las cartas bien a la vista.</p>
            <PhotoButton primary label="Foto de la mesa" busy={busy} onPhoto={image => sendPhoto({ kind: 'board', image })} />
            {remotes.length === 0 && <p className="muted small">Cuando entre otro jugador vas a poder mandarle sus cartas.</p>}
            {remotes.map(m => (
              <div key={m.userId} className="row-between">
                <PhotoButton label={`Cartas de ${m.name}${view.sent[m.playerId] ? ' ✓' : ''}`} busy={busy} onPhoto={image => sendPhoto({ kind: 'hole', playerId: m.playerId, image })} />
              </div>
            ))}
            <div className="row">
              {state.source === 'table' && state.local
                ? <Btn variant="danger" className="grow" onClick={state.stop}>Detener cámara de la mesa</Btn>
                : <Btn variant="ghost" className="grow" busy={state.starting} onClick={() => { void state.startTable(); }}><Emoji>🎥</Emoji> Transmitir la mesa</Btn>}
              <Btn variant="ghost" className="grow" busy={busy} onClick={() => { void newHand(); }}>Nueva mano</Btn>
            </div>
            {state.error && <div className="notice notice-err" role="alert">{state.error}</div>}
          </div>
        </>
      )}

      {view.canManage && (
        <>
          <h2 className="section-title">Invitar y administrar</h2>
          <div className="card stack">
            <div className="row">
              <Btn variant="ghost" className="grow" onClick={() => { void shareText(`Sumate a la partida a distancia: ${link}`, notify); }}><Emoji>📤</Emoji> Compartir link</Btn>
              <Btn variant="ghost" className="grow" onClick={() => { void navigator.clipboard?.writeText(link).then(() => notify('Link copiado.')).catch(() => notify(link)); }}>Copiar</Btn>
            </div>
            <p className="xs muted">Pantalla para la mesa (tablet o celular fijo): <a href={`${link}?mesa`}>{`${link}?mesa`}</a></p>
            <Btn variant="danger" busy={busy} onClick={() => { void closeRoom(); }}>Cerrar la sala</Btn>
          </div>
        </>
      )}

      <EmojiLayer handler={emojiHandler} enabled={prefs.emojis} sound={prefs.emojiSound} />
      {prefs.emojis && me && <EmojiFab placement="page" live={socket.live} onSend={socket.sendEmoji} />}
    </VideoProvider>
  );
}
