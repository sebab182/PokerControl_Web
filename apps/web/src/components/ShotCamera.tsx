import { useEffect, useRef, useState } from 'react';
import { cardsToJpeg, frameToJpeg, resizeToJpeg } from '../photo';
import { CardCapturer } from '../vision/capture';
import { detectCards, extractCard, sharpness } from '../vision/detect';
import { Btn, Modal } from './ui';

export interface ShotStep { id: string; label: string; done: boolean }

type Facing = 'environment' | 'user';

const WORK_MAX = 640;
const FULL_MAX = 1920;
const TICK_MS = 150;
/** Cuántas cartas nuevas se esperan en cada paso: las dos del remoto, tres del flop y una del turn y del river. */
const expectedCards = (stepId: string): number => (stepId.startsWith('hole:') ? 2 : stepId === 'board:flop' ? 3 : 1);

/**
 * Cámara dentro de la app para cargar las cartas: se ve la imagen, se toca «Sacar y enviar» y la foto sale en el momento,
 * sin pantalla de confirmación (a diferencia de la cámara del sistema, que obliga a aceptar la foto). La cámara queda
 * abierta para la foto siguiente y el paso avanza solo: primero las cartas de cada remoto y después el flop, el turn y el
 * river. Si no hay cámara o falta el permiso, se ofrece la cámara del sistema como alternativa.
 *
 * Envío automático (por defecto): la cámara busca cartas en el video sin leerlas; cuando las que corresponden al paso
 * (2, 3 o 1) quedan quietas unos instantes, las recorta enderezadas del cuadro y las manda sola, sin tocar nada.
 */
export function ShotCamera({ steps, initial, onShot, onClose }: {
  steps: ShotStep[]; initial: string; onShot: (stepId: string, base64: string) => Promise<void>; onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const fallback = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<Facing>('environment');
  const [step, setStep] = useState(initial);
  const [ready, setReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noCamera, setNoCamera] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [hint, setHint] = useState('');
  const capturer = useRef(new CardCapturer());
  const busy = useRef(false);
  const stepRef = useRef(initial);
  const coolUntil = useRef(0);

  // La cámara se abre al mostrarse y se apaga al cerrar o al cambiar de lente.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setReady(false);
    if (!navigator.mediaDevices?.getUserMedia) { setNoCamera(true); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(s => {
        if (cancelled) { for (const t of s.getTracks()) t.stop(); return; }
        stream = s;
        setNoCamera(false);
        const el = video.current;
        if (el) { el.srcObject = s; void el.play().catch(() => {}); }
      })
      .catch(() => { if (!cancelled) setNoCamera(true); });
    return () => { cancelled = true; if (stream) for (const t of stream.getTracks()) t.stop(); };
  }, [facing]);

  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), 2500);
    return () => clearTimeout(t);
  }, [sent]);

  const current = steps.find(x => x.id === step) ?? steps[0];
  stepRef.current = current?.id ?? step;

  /** Manda la foto y pasa al paso siguiente (el último queda donde está). Devuelve si salió. */
  const send = async (make: () => Promise<string>): Promise<boolean> => {
    if (!current || busy.current) return false;
    busy.current = true;
    setSending(true);
    setError(null);
    try {
      await onShot(current.id, await make());
      setSent(`Enviado: ${current.label} ✓`);
      const next = steps[steps.findIndex(x => x.id === current.id) + 1];
      if (next) setStep(next.id);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo mandar la foto.');
      return false;
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  // Envío automático: cada tanto se miran las cartas del video y, cuando están quietas, se recortan y se mandan.
  const sendRef = useRef(send);
  sendRef.current = send;
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  useEffect(() => {
    if (!auto || !ready || noCamera) { setHint(''); return; }
    const work = document.createElement('canvas');
    const full = document.createElement('canvas');
    const tick = () => {
      const el = video.current;
      if (!el || !el.videoWidth || busy.current || Date.now() < coolUntil.current) return;
      const id = stepRef.current;
      const done = stepsRef.current.find(x => x.id === id)?.done;
      const expected = expectedCards(id);
      const k = Math.min(1, WORK_MAX / el.videoWidth);
      work.width = Math.round(el.videoWidth * k); work.height = Math.round(el.videoHeight * k);
      const wctx = work.getContext('2d', { willReadFrequently: true });
      if (!wctx) return;
      wctx.drawImage(el, 0, 0, work.width, work.height);
      const boxes = detectCards(wctx.getImageData(0, 0, work.width, work.height), { minArea: 0.02, corners: false });
      const st = capturer.current.update(boxes, expected);
      setHint(st.visible === 0 ? 'Buscando cartas…' : st.ready ? 'Cartas quietas: enviando…' : `Veo ${st.visible} de ${expected} carta${expected > 1 ? 's' : ''}${st.visible === expected ? ': mantenelas quietas' : ''}`);
      if (!st.ready || done) return;
      // Las cartas se recortan del cuadro completo (mucho más nítido que el de trabajo).
      const f = Math.min(1, FULL_MAX / el.videoWidth);
      full.width = Math.round(el.videoWidth * f); full.height = Math.round(el.videoHeight * f);
      const fctx = full.getContext('2d', { willReadFrequently: true });
      if (!fctx) return;
      fctx.drawImage(el, 0, 0, full.width, full.height);
      const big = fctx.getImageData(0, 0, full.width, full.height);
      const crops = st.fresh.map(c => extractCard(big, c.box, full.width / work.width));
      if (crops.some(c => sharpness(c) < 3)) return; // borrosa: se espera al cuadro siguiente
      const ids = st.fresh.map(c => c.id);
      void sendRef.current(() => cardsToJpeg(crops)).then(ok => {
        if (ok) capturer.current.consume(ids); else coolUntil.current = Date.now() + 3000;
      });
    };
    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [auto, ready, noCamera]);

  return (
    <Modal open onClose={onClose} title="Cargar las cartas" className="shot-modal">
      <div className="shot-steps" role="group" aria-label="Qué estás fotografiando">
        {steps.map(x => (
          <Btn key={x.id} variant="ghost" aria-pressed={x.id === current?.id} onClick={() => setStep(x.id)}>{x.done ? '✓ ' : ''}{x.label}</Btn>
        ))}
      </div>

      {noCamera
        ? (
          <div className="stack">
            <p className="small muted">No se pudo abrir la cámara: revisá el permiso del navegador. Podés usar la cámara del sistema (te va a pedir confirmar cada foto).</p>
            <input ref={fallback} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="shot-fallback"
              onChange={e => { const file = e.target.files?.[0]; if (file) void send(() => resizeToJpeg(file)); e.target.value = ''; }} />
            <Btn onClick={() => fallback.current?.click()}>Usar la cámara del sistema</Btn>
          </div>
        )
        : (
          <>
            <video ref={video} className="shot-video" autoPlay playsInline muted aria-label="Vista de la cámara"
              onLoadedData={() => setReady(true)} />
            <p className="small" role="status" aria-live="polite" data-testid="shot-hint">{auto ? hint : 'Envío automático apagado: usá el botón.'}</p>
            <div className="shot-actions">
              <Btn block busy={sending} disabled={!ready || !current} onClick={() => { const el = video.current; if (el) void send(() => frameToJpeg(el)); }} data-testid="shot-button">
                Sacar y enviar{current ? `: ${current.label}` : ''}
              </Btn>
              <div className="row-wrap">
                <Btn variant="ghost" className="grow" aria-pressed={auto} onClick={() => setAuto(a => !a)}>Envío automático: {auto ? 'sí' : 'no'}</Btn>
                <Btn variant="ghost" className="grow" onClick={() => setFacing(f => (f === 'environment' ? 'user' : 'environment'))}>Cambiar de cámara</Btn>
                <Btn variant="ghost" className="grow" onClick={onClose}>Listo</Btn>
              </div>
            </div>
          </>
        )}
      <p className="small" role="status" aria-live="polite" data-testid="shot-status">{sent ?? ''}</p>
      {error && <div className="notice notice-err" role="alert">{error}</div>}
    </Modal>
  );
}
