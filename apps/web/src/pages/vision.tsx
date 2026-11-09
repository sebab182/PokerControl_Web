import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Btn, Empty } from '../components/ui';
import { PokerCard } from '../components/poker';
import { useSession } from '../context';
import { readCards, preload, type Reading } from '../vision/classify';
import { detectCards, type CardBox } from '../vision/detect';
import { Stabilizer, type Stable } from '../vision/stabilize';

const FRAME_MAX = 640;
const EVERY_MS = 120;
/** Debajo de esto la lectura se descarta: casi siempre es una mancha clara que no es una carta. */
const MIN_CONFIDENCE = 0.35;

interface Stats { ms: number; fps: number; found: number }

/** Pantalla de prueba del reconocimiento de cartas (solo administradores): cámara o imagen → cartas dibujadas. */
export function VisionPage() {
  const { canEdit } = useSession();
  const video = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const work = useRef<HTMLCanvasElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const busy = useRef(false);
  const frozen = useRef(false);
  const stabilizer = useRef(new Stabilizer());
  const [model, setModel] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState('');
  const [stable, setStable] = useState<Stable[]>([]);
  const [live, setLive] = useState<Reading[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [freeze, setFreeze] = useState(false);
  const [source, setSource] = useState<'camera' | 'image'>('camera');

  const load = useCallback(async () => {
    setModel('loading');
    try { await preload(); setModel('ready'); } catch (e) { setModel('error'); setError(e instanceof Error ? e.message : 'No se pudo cargar el modelo'); }
  }, []);
  useEffect(() => { if (canEdit) void load(); }, [canEdit, load]);

  const draw = (boxes: CardBox[], readings: Reading[], sw: number, sh: number) => {
    const c = overlay.current;
    if (!c) return;
    c.width = sw; c.height = sh;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, sw, sh);
    g.lineWidth = Math.max(2, sw / 200);
    g.font = `${Math.max(14, sw / 28)}px sans-serif`;
    boxes.forEach((b, i) => {
      const r = readings[i];
      const ok = r && r.confidence >= 0.8;
      g.strokeStyle = ok ? '#22c55e' : '#f59e0b';
      g.fillStyle = g.strokeStyle;
      g.beginPath();
      b.corners.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath(); g.stroke();
      if (r) g.fillText(`${r.card} ${Math.round(r.confidence * 100)}%`, b.center.x - 20, b.center.y);
    });
  };

  /** Procesa el cuadro actual de `source` (video o imagen ya dibujada en el lienzo de trabajo). */
  const process = useCallback(async (smooth: boolean) => {
    const cv = work.current;
    if (!cv || busy.current) return;
    busy.current = true;
    const t0 = performance.now();
    try {
      const img = cv.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, cv.width, cv.height);
      if (!img) return;
      const boxes = detectCards(img, { minArea: 0.02 });
      const readings = await readCards(boxes);
      draw(boxes, readings, cv.width, cv.height);
      if (!frozen.current) {
        setLive(readings);
        if (smooth) setStable(stabilizer.current.update(boxes.map((b, i) => ({ center: b.center, reading: readings[i] })).filter(it => it.reading.confidence >= MIN_CONFIDENCE)));
        else setStable(readings.map((r, i) => ({ id: i, card: r.card, confidence: r.confidence, votes: 1, center: boxes[i].center })).filter(s => s.confidence >= MIN_CONFIDENCE));
      }
      const ms = performance.now() - t0;
      setStats({ ms: Math.round(ms), fps: Math.round(1000 / Math.max(ms, EVERY_MS)), found: boxes.length });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al reconocer');
    } finally { busy.current = false; }
  }, []);

  const tick = useCallback(() => {
    const v = video.current, cv = work.current;
    if (v && cv && v.videoWidth) {
      const k = Math.min(1, FRAME_MAX / v.videoWidth);
      cv.width = Math.round(v.videoWidth * k); cv.height = Math.round(v.videoHeight * k);
      cv.getContext('2d')?.drawImage(v, 0, 0, cv.width, cv.height);
      void process(true);
    }
    timer.current = window.setTimeout(tick, EVERY_MS);
  }, [process]);

  const stop = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    setCamera(false);
  }, []);
  useEffect(() => stop, [stop]);

  const start = async () => {
    setError(''); setSource('camera'); stabilizer.current.reset(); setStable([]); setLive([]);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      stream.current = s;
      if (video.current) { video.current.srcObject = s; await video.current.play(); }
      setCamera(true);
      tick();
    } catch {
      setError('No se pudo abrir la cámara. Revisá el permiso del navegador o probá con una imagen.');
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    stop(); setError(''); setSource('image');
    const bmp = await createImageBitmap(file);
    const cv = work.current;
    if (!cv) return;
    const k = Math.min(1, FRAME_MAX / bmp.width);
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext('2d')?.drawImage(bmp, 0, 0, cv.width, cv.height);
    await process(false);
  };

  useEffect(() => { frozen.current = freeze; }, [freeze]);

  if (!canEdit) return <Empty icon="🔒" title="Solo para administradores" />;

  return (
    <div className="vision">
      <p><Link to="/settings">← Ajustes</Link></p>
      <h1>Prueba de reconocimiento de cartas</h1>
      <p className="muted">Apuntá la cámara a cartas sobre una mesa oscura, o subí una foto. Todo se procesa en este teléfono; no se envía nada.</p>
      <p role="status" data-testid="vision-model">
        {model === 'loading' && 'Cargando el modelo…'}{model === 'ready' && 'Modelo listo'}{model === 'error' && `No se pudo cargar el modelo${error ? `: ${error}` : ''}`}
      </p>
      <div className="row vision-actions">
        {camera
          ? <Btn variant="ghost" onClick={stop}>Apagar cámara</Btn>
          : <Btn onClick={() => { void start(); }} disabled={model !== 'ready'}>Abrir cámara</Btn>}
        <label className="btn btn-ghost vision-file">
          Subir imagen
          <input type="file" accept="image/*" data-testid="vision-file" onChange={e => { void onFile(e.target.files?.[0]); e.target.value = ''; }} disabled={model !== 'ready'} />
        </label>
        <Btn variant="ghost" onClick={() => setFreeze(f => !f)} aria-pressed={freeze}>{freeze ? 'Seguir' : 'Fijar'}</Btn>
        {model === 'error' && <Btn variant="ghost" onClick={() => { void load(); }}>Reintentar</Btn>}
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="vision-stage" hidden={!camera && source !== 'image'}>
        <video ref={video} playsInline muted className="vision-video" hidden={source !== 'camera'} />
        <canvas ref={work} className="vision-work" hidden={source !== 'image'} aria-label="Imagen analizada" />
        <canvas ref={overlay} className="vision-overlay" aria-hidden="true" />
      </div>
      {stats && <p className="muted" data-testid="vision-stats">{stats.found} carta(s) detectada(s) · {stats.ms} ms por cuadro · ~{stats.fps} cuadros/s</p>}
      <h2 className="section-title">Cartas reconocidas</h2>
      {stable.length === 0 && <p className="muted">Todavía no hay cartas estables.</p>}
      <ul className="vision-cards" data-testid="vision-cards">
        {stable.map(s => (
          <li key={s.id}>
            <PokerCard card={s.card} size="lg" />
            <span className="muted">{Math.round(s.confidence * 100)} %</span>
          </li>
        ))}
      </ul>
      {live.length > 0 && <p className="muted">En vivo: {live.map(r => `${r.card} ${Math.round(r.confidence * 100)}%`).join(' · ')}</p>}
    </div>
  );
}
