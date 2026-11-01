import { formatSigned } from '@pokercontrol/core';
import { useEffect, useRef } from 'react';

const POINT_W = 56;
const LEFT = 44;
const TOP = 12;
const BOTTOM = 42;
const RIGHT = 16;

function niceStep(range: number): number {
  const raw = range / 4 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / pow;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
}

/** Balance por partida. Mismo criterio que LineChart de la APK: incluye el 0 y parte los tramos que lo cruzan. */
export function LineChart({ data, labels, height = 220 }: { data: number[]; labels: string[]; height?: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth;
  }, [data]);
  if (data.length < 2) return null;

  const rawMax = Math.max(0, ...data);
  const rawMin = Math.min(0, ...data);
  const step = niceStep(rawMax - rawMin);
  const max = Math.ceil(rawMax / step) * step;
  const min = Math.floor(rawMin / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);

  const plotH = height - TOP - BOTTOM;
  const width = LEFT + RIGHT + POINT_W * (data.length - 1) + POINT_W / 2;
  const x = (i: number) => LEFT + POINT_W / 4 + i * POINT_W;
  const y = (v: number) => TOP + (max === min ? plotH / 2 : ((max - v) / (max - min)) * plotH);

  const segments: { x1: number; y1: number; x2: number; y2: number; up: boolean }[] = [];
  for (let i = 0; i < data.length - 1; i++) {
    const p = data[i];
    const q = data[i + 1];
    if ((p > 0 && q < 0) || (p < 0 && q > 0)) {
      const t = p / (p - q);
      const midX = x(i) + (x(i + 1) - x(i)) * t;
      segments.push({ x1: x(i), y1: y(p), x2: midX, y2: y(0), up: p > 0 });
      segments.push({ x1: midX, y1: y(0), x2: x(i + 1), y2: y(q), up: q > 0 });
    } else {
      segments.push({ x1: x(i), y1: y(p), x2: x(i + 1), y2: y(q), up: p + q >= 0 });
    }
  }

  const summary = `Balance por partida. Último: ${formatSigned(data[data.length - 1])}; máximo ${formatSigned(rawMax)}; mínimo ${formatSigned(rawMin)}.`;

  return (
    <div className="chart-scroll" ref={scroller} tabIndex={0} role="group" aria-label="Gráfico con desplazamiento horizontal">
      <svg width={Math.max(width, 280)} height={height} role="img" aria-label={summary}>
        {ticks.map(t => (
          <g key={t}>
            <line x1={LEFT} x2={width - RIGHT / 2} y1={y(t)} y2={y(t)} className={t === 0 ? 'chart-zero' : 'chart-grid'} />
            <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">
              {(t / 1000).toLocaleString('es-AR')}
            </text>
          </g>
        ))}
        {segments.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} className={s.up ? 'chart-up' : 'chart-down'} />
        ))}
        {data.map((v, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(v)} r={4} className={v >= 0 ? 'dot-up' : 'dot-down'}>
              <title>{`${labels[i]}: ${formatSigned(v)}`}</title>
            </circle>
            <text x={x(i)} y={height - BOTTOM + 16} textAnchor="middle" className="chart-axis">
              {(labels[i] ?? '').length > 8 ? `${labels[i].slice(0, 7)}…` : labels[i]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
