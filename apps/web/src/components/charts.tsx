import { formatMoney } from '@pokercontrol/core';
import { useEffect, useRef, useState } from 'react';

const formatSigned = (v: number) => (Math.round(v) === 0 ? '$0' : `${v > 0 ? '+' : '−'}${formatMoney(Math.abs(Math.round(v)))}`);

/** Paso "redondo" para los ejes (1, 2, 5 × 10ⁿ). */
function niceStep(range: number): number {
  const raw = range / 4 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / pow;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
}

const compact = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('es-AR', { maximumFractionDigits: 1 })}k` : v.toLocaleString('es-AR'));

export interface ChartLine {
  id: string;
  name: string;
  /** Una línea punteada se usa para "lo esperado" frente a "lo real". */
  dashed?: boolean;
  /** 1 a 8: color de la paleta (--p1…--p8). */
  color: number;
}

export interface ChartPoint { label: string; values: Record<string, number> }

/** Ancho real del contenedor, para dibujar con tipografía de tamaño fijo también en el celular. */
function useWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(Math.max(260, Math.round(el.clientWidth)));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const LEFT = 46;
const RIGHT = 12;
const TOP = 10;
const BOTTOM = 26;

/**
 * Líneas sobre el eje del tiempo (una mano por punto). Ocupa todo el ancho disponible; la leyenda va debajo con el
 * último valor de cada línea para no depender solo del color.
 */
export function SeriesChart({ points, lines, height = 220, title }: { points: ChartPoint[]; lines: ChartLine[]; height?: number; title: string }) {
  const [ref, W] = useWidth();
  if (points.length < 2 || lines.length === 0) return null;
  const all = lines.flatMap(l => points.map(p => p.values[l.id] ?? 0));
  const rawMax = Math.max(0, ...all);
  const rawMin = Math.min(0, ...all);
  const step = niceStep(rawMax - rawMin);
  const max = Math.ceil(rawMax / step) * step;
  const min = Math.floor(rawMin / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const plotH = height - TOP - BOTTOM;
  const x = (i: number) => LEFT + (i / (points.length - 1)) * (W - LEFT - RIGHT);
  const y = (v: number) => TOP + (max === min ? plotH / 2 : ((max - v) / (max - min)) * plotH);
  const last = points[points.length - 1];
  const summary = `${title}. ${lines.map(l => `${l.name}: ${formatSigned(last.values[l.id] ?? 0)}`).join('; ')}.`;
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(3, Math.floor(W / 70))));

  return (
    <figure className="chart" ref={ref as React.RefObject<HTMLElement>}>
      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img" aria-label={summary}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
            <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">{compact(t)}</text>
          </g>
        ))}
        {points.map((p, i) => (i % labelEvery === 0 || i === points.length - 1) && (
          <text key={p.label + i} x={x(i)} y={height - 8} textAnchor="middle" className="chart-axis">{p.label}</text>
        ))}
        {lines.map(l => (
          <polyline key={l.id} fill="none" strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round"
            className={`series series-${l.color}`} strokeDasharray={l.dashed ? '6 4' : undefined}
            points={points.map((p, i) => `${x(i).toFixed(1)},${y(p.values[l.id] ?? 0).toFixed(1)}`).join(' ')} />
        ))}
      </svg>
      <figcaption className="legend">
        {lines.map(l => (
          <span key={l.id} className="legend-item">
            <span className={`swatch series-bg-${l.color}${l.dashed ? ' swatch-dashed' : ''}`} aria-hidden="true" />
            {l.name} <strong>{formatSigned(last.values[l.id] ?? 0)}</strong>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export interface BarRow { label: string; value: number; hint?: string }

/**
 * Barras horizontales desde un cero central: a la derecha lo positivo (verde) y a la izquierda lo negativo (rojo).
 * `format` da el texto de cada valor.
 */
export function BarList({ rows, format = formatSigned, title }: { rows: BarRow[]; format?: (v: number) => string; title: string }) {
  if (rows.length === 0) return null;
  const max = Math.max(1, ...rows.map(r => Math.abs(r.value)));
  const signed = rows.some(r => r.value < 0);
  return (
    <ul className="bars" aria-label={title}>
      {rows.map(r => (
        <li key={r.label} className="bar-row">
          <span className="bar-label">{r.label}{r.hint && <span className="xs muted"> {r.hint}</span>}</span>
          <span className="bar-track" aria-hidden="true">
            <span className={`bar ${r.value < 0 ? 'bar-neg' : 'bar-pos'}`}
              style={signed
                ? { width: `${(Math.abs(r.value) / max) * 50}%`, [r.value < 0 ? 'right' : 'left']: '50%' }
                : { width: `${(r.value / max) * 100}%`, left: 0 }} />
            {signed && <span className="bar-zero" />}
          </span>
          <span className="bar-value">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Columnas verticales (una por mano), p. ej. el pozo de cada mano. */
export function Columns({ data, title, height = 130 }: { data: { label: string; value: number; tip: string }[]; title: string; height?: number }) {
  const [ref, W] = useWidth();
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map(d => d.value));
  const bw = Math.min(24, (W - LEFT - RIGHT) / data.length);
  const plotH = height - TOP - BOTTOM;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(3, Math.floor(W / 56))));
  return (
    <figure className="chart" ref={ref as React.RefObject<HTMLElement>}>
      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} role="img"
        aria-label={`${title}. ${data.length} manos; el mayor es ${compact(max)}.`}>
        <line x1={LEFT} x2={W - RIGHT} y1={TOP + plotH} y2={TOP + plotH} className="chart-zero" />
        <text x={LEFT - 6} y={TOP + 9} textAnchor="end" className="chart-axis">{compact(max)}</text>
        <text x={LEFT - 6} y={TOP + plotH} textAnchor="end" className="chart-axis">0</text>
        {data.map((d, i) => {
          const h = (d.value / max) * plotH;
          const cx = LEFT + (i + 0.5) * ((W - LEFT - RIGHT) / data.length);
          return (
            <g key={i}>
              <rect x={cx - bw * 0.4} y={TOP + plotH - h} width={bw * 0.8} height={Math.max(1, h)} rx={2} className="column"><title>{d.tip}</title></rect>
              {i % labelEvery === 0 && <text x={cx} y={height - 8} textAnchor="middle" className="chart-axis">{d.label}</text>}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
