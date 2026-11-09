import { useEffect, useRef, useState } from 'react';
import { frameToJpeg, resizeToJpeg } from '../photo';
import { Btn, Modal } from './ui';

export interface ShotStep { id: string; label: string; done: boolean }

type Facing = 'environment' | 'user';

/**
 * Cámara dentro de la app para cargar las cartas: se ve la imagen, se toca «Sacar y enviar» y la foto sale en el momento,
 * sin pantalla de confirmación (a diferencia de la cámara del sistema, que obliga a aceptar la foto). La cámara queda
 * abierta para la foto siguiente y el paso avanza solo: primero las cartas de cada remoto y después el flop, el turn y el
 * river. Si no hay cámara o falta el permiso, se ofrece la cámara del sistema como alternativa.
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

  /** Manda la foto y pasa al paso siguiente (el último queda donde está). */
  const send = async (make: () => Promise<string>) => {
    if (!current || sending) return;
    setSending(true);
    setError(null);
    try {
      await onShot(current.id, await make());
      setSent(`Enviado: ${current.label} ✓`);
      const next = steps[steps.findIndex(x => x.id === current.id) + 1];
      if (next) setStep(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo mandar la foto.');
    } finally {
      setSending(false);
    }
  };

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
            <Btn block busy={sending} disabled={!ready || !current} onClick={() => { const el = video.current; if (el) void send(() => frameToJpeg(el)); }} data-testid="shot-button">
              Sacar y enviar{current ? `: ${current.label}` : ''}
            </Btn>
            <div className="row">
              <Btn variant="ghost" className="grow" onClick={() => setFacing(f => (f === 'environment' ? 'user' : 'environment'))}>Cambiar de cámara</Btn>
              <Btn variant="ghost" className="grow" onClick={onClose}>Listo</Btn>
            </div>
          </>
        )}
      <p className="small" role="status" aria-live="polite" data-testid="shot-status">{sent ?? ''}</p>
      {error && <div className="notice notice-err" role="alert">{error}</div>}
    </Modal>
  );
}
