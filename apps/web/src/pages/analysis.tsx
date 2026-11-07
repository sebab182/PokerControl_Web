import type { ApiPlayerInsights, ApiSession, ApiSessionAnalysis } from '@pokercontrol/contracts';
import { formatMoney } from '@pokercontrol/core';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiRequestError, api } from '../api';
import { BarList, Columns, SeriesChart, type ChartLine } from '../components/charts';
import { PokerCard } from '../components/poker';
import { Btn, Emoji, Empty, Loading, Money, QueryError } from '../components/ui';
import { useGroup } from '../context';

type Rate = ApiPlayerInsights['vpip'];
type Tab = 'resumen' | 'jugadores' | 'manos' | 'queif';

const TABS: { id: Tab; label: string }[] = [
  { id: 'resumen', label: 'Resumen' },
  { id: 'jugadores', label: 'Jugadores' },
  { id: 'manos', label: 'Manos' },
  { id: 'queif', label: 'Qué hubiese pasado' },
];

const STREET: Record<string, string> = { preflop: 'preflop', flop: 'flop', turn: 'turn', river: 'river' };
const KIND: Record<string, string> = { fold: 'se retiró', check: 'pasó', call: 'igualó', raise: 'subió a' };

const pct = (r: Rate) => (r.d === 0 ? '—' : `${Math.round((r.n / r.d) * 100)}%`);
const frac = (r: Rate) => (r.d === 0 ? 'sin datos' : `${r.n} de ${r.d}`);
/** Importe con signo, redondeado: −$1.000 / +$340 (el formato del core muestra $-1.000). */
const signed = (v: number) => (Math.round(v) === 0 ? '$0' : `${v > 0 ? '+' : '−'}${formatMoney(Math.abs(Math.round(v)))}`);
function Signed({ amount }: { amount: number }) {
  return <span className={`money ${amount > 0.5 ? 'pos' : amount < -0.5 ? 'neg' : 'muted'}`}>{signed(amount)}</span>;
}
const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);

function Stat({ name, value, detail }: { name: string; value: string; detail: string }) {
  return (
    <div className="stat">
      <div className="stat-name">{name}</div>
      <div className="big">{value}</div>
      <div className="xs muted">{detail}</div>
    </div>
  );
}

export function SessionAnalysisPage() {
  const { sessionId = '' } = useParams();
  const { path, key } = useGroup();
  const session = useQuery({
    queryKey: key('session', sessionId),
    queryFn: () => api<ApiSession>(path(`/sessions/${sessionId}`)),
  });
  const closed = session.data?.status === 'closed';
  const analysis = useQuery({
    queryKey: key('session-analysis', sessionId),
    queryFn: () => api<ApiSessionAnalysis>(path(`/sessions/${sessionId}/analysis`)),
    enabled: closed,
  });
  const [tab, setTab] = useState<Tab>('resumen');

  if (session.isLoading) return <Loading />;
  if (session.error instanceof ApiRequestError && session.error.status === 404) {
    return <Empty icon="🔍" title="Partida no encontrada"><p><Link to="/seasons">Volver a temporadas</Link></p></Empty>;
  }
  if (session.error || !session.data) return <QueryError error={session.error} onRetry={() => { void session.refetch(); }} />;

  const head = (
    <>
      <Link className="breadcrumb" to={`/sessions/${sessionId}`}>← Partida</Link>
      <h1 style={{ marginBottom: 12 }}>Análisis · {session.data.name}</h1>
    </>
  );

  if (!closed) {
    return (
      <>
        {head}
        <Empty icon="🔒" title="Se habilita al cerrar la partida">
          <p>El análisis muestra las cartas de todos, así que espera a que termine el juego.</p>
        </Empty>
      </>
    );
  }
  if (analysis.isLoading) return <>{head}<Loading /></>;
  if (analysis.error || !analysis.data) return <>{head}<QueryError error={analysis.error} onRetry={() => { void analysis.refetch(); }} /></>;
  const data = analysis.data;
  if (data.hands === 0) {
    return (
      <>
        {head}
        <Empty icon="🃏" title="Esta partida no tiene manos registradas">
          <p>El análisis se arma con las manos jugadas en la mesa online.</p>
        </Empty>
      </>
    );
  }

  return (
    <>
      {head}
      <div className="segmented analysis-tabs" role="group" aria-label="Secciones del análisis">
        {TABS.map(t => (
          <Btn key={t.id} variant="ghost" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</Btn>
        ))}
      </div>
      {tab === 'resumen' && <Summary data={data} />}
      {tab === 'jugadores' && <Players data={data} />}
      {tab === 'manos' && <Hands data={data} />}
      {tab === 'queif' && <WhatIf data={data} />}
    </>
  );
}

const nameOf = (data: ApiSessionAnalysis, id: string) => data.names[id] ?? 'Jugador';
const lineOf = (data: ApiSessionAnalysis, id: string, dashed = false): ChartLine => ({
  id, name: nameOf(data, id), color: (data.players.findIndex(p => p.playerId === id) % 8) + 1, dashed,
});

function Summary({ data }: { data: ApiSessionAnalysis }) {
  const pots = data.series.pot;
  const biggest = pots.reduce((a, b) => (b.pot > a.pot ? b : a), pots[0]);
  const showdowns = pots.filter(p => p.showdown).length;
  const avg = Math.round(pots.reduce((s, p) => s + p.pot, 0) / pots.length);
  const points = data.series.net.map(p => ({ label: `#${p.handNo}`, values: p.values }));
  const ended = data.series.endedOn;
  return (
    <>
      <div className="stat-grid">
        <Stat name="Manos" value={String(data.hands)} detail="jugadas en la partida" />
        <Stat name="Pozo promedio" value={formatMoney(avg)} detail="por mano" />
        <Stat name="Pozo mayor" value={formatMoney(biggest.pot)} detail={`mano #${biggest.handNo}`} />
        <Stat name="Llegaron al showdown" value={`${Math.round((showdowns / pots.length) * 100)}%`} detail={`${showdowns} de ${pots.length} manos`} />
      </div>

      <h2 className="section-title">Resultado acumulado</h2>
      <div className="card">
        {points.length > 1
          ? <SeriesChart title="Resultado acumulado de cada jugador, mano a mano" points={points} lines={data.players.map(p => lineOf(data, p.playerId))} />
          : <p className="muted small">Con una sola mano todavía no hay evolución para graficar.</p>}
      </div>

      <h2 className="section-title">Jugadores</h2>
      <div className="card table-scroll" tabIndex={0} role="group" aria-label="Resumen por jugador (se desplaza horizontalmente)">
        <table>
          <caption className="sr-only">Resumen por jugador</caption>
          <thead><tr><th scope="col">Jugador</th><th scope="col">Manos</th><th scope="col">Resultado</th><th scope="col" title="Ganancia en ciegas grandes cada 100 manos">BB/100</th><th scope="col">VPIP</th><th scope="col">PFR</th></tr></thead>
          <tbody>
            {data.players.map(p => (
              <tr key={p.playerId}>
                <th scope="row">{nameOf(data, p.playerId)}</th>
                <td>{p.hands}</td>
                <td><Signed amount={p.net} /></td>
                <td>{p.bb100.toLocaleString('es-AR')}</td>
                <td>{pct(p.vpip)}</td>
                <td>{pct(p.pfr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="section-title">Pozo de cada mano</h2>
      <div className="card">
        <Columns title="Pozo de cada mano" data={pots.map(p => ({ label: `#${p.handNo}`, value: p.pot, tip: `Mano #${p.handNo}: pozo ${formatMoney(p.pot)}, terminó en ${STREET[p.endedOn]}` }))} />
      </div>

      <h2 className="section-title">Dónde terminan las manos</h2>
      <div className="card">
        <BarList title="Manos según la calle en que terminan" format={v => `${v} (${Math.round((v / data.hands) * 100)}%)`}
          rows={[
            { label: 'Preflop', value: ended.preflop }, { label: 'Flop', value: ended.flop },
            { label: 'Turn', value: ended.turn }, { label: 'River', value: ended.river },
          ]} />
      </div>
    </>
  );
}

function Players({ data }: { data: ApiSessionAnalysis }) {
  const [id, setId] = useState(data.players[0].playerId);
  const p = data.players.find(x => x.playerId === id) ?? data.players[0];
  const real = data.series.net.map(pt => ({ label: `#${pt.handNo}`, values: { real: pt.values[p.playerId] ?? 0, esperado: data.series.evNet.find(e => e.handNo === pt.handNo)?.values[p.playerId] ?? 0 } }));
  const af = p.aggression.calls === 0 ? (p.aggression.raises === 0 ? '—' : '∞') : (p.aggression.raises / p.aggression.calls).toFixed(1);
  const color = (data.players.findIndex(x => x.playerId === p.playerId) % 8) + 1;
  return (
    <>
      <div className="segmented analysis-tabs" role="group" aria-label="Jugador">
        {data.players.map(x => (
          <Btn key={x.playerId} variant="ghost" aria-pressed={x.playerId === p.playerId} onClick={() => setId(x.playerId)}>{nameOf(data, x.playerId)}</Btn>
        ))}
      </div>
      <div className="stat-grid">
        <Stat name="Resultado" value={signed(p.net)} detail={`en ${p.hands} manos`} />
        <Stat name="BB/100" value={p.bb100.toLocaleString('es-AR')} detail="ciegas grandes ganadas cada 100 manos" />
        <Stat name="Pozo promedio" value={formatMoney(p.avgPot)} detail="de las manos en que jugó" />
        <Stat name="Tiempo de decisión" value={secs(p.avgThinkMs)} detail="promedio por jugada" />
      </div>
      <h2 className="section-title">Cómo juega</h2>
      <div className="stat-grid">
        <Stat name="VPIP" value={pct(p.vpip)} detail={`Entra al pozo por voluntad propia (${frac(p.vpip)} manos)`} />
        <Stat name="PFR" value={pct(p.pfr)} detail={`Sube antes del flop (${frac(p.pfr)})`} />
        <Stat name="3-bet" value={pct(p.threeBet)} detail={`Re-sube ante una subida (${frac(p.threeBet)})`} />
        <Stat name="Retirarse al 3-bet" value={pct(p.foldToThreeBet)} detail={`Tira tras abrir y recibir una re-subida (${frac(p.foldToThreeBet)})`} />
        <Stat name="C-bet" value={pct(p.cbet)} detail={`Apuesta al flop tras haber subido antes (${frac(p.cbet)})`} />
        <Stat name="Retirarse a la c-bet" value={pct(p.foldToCbet)} detail={`Tira ante esa apuesta (${frac(p.foldToCbet)})`} />
        <Stat name="Robo de ciegas" value={pct(p.steal)} detail={`Sube desde el final si nadie entró (${frac(p.steal)})`} />
        <Stat name="Defensa de la ciega grande" value={pct(p.bbDefend)} detail={`Se queda ante una subida (${frac(p.bbDefend)})`} />
        <Stat name="Agresión (AF)" value={af} detail={`Subidas por igualada después del flop (${p.aggression.raises} y ${p.aggression.calls})`} />
        <Stat name="Frecuencia de agresión" value={pct(p.aggressionFreq)} detail="Subidas sobre subir, igualar o retirarse" />
        <Stat name="WTSD" value={pct(p.wtsd)} detail={`Llega al showdown tras ver el flop (${frac(p.wtsd)})`} />
        <Stat name="W$SD" value={pct(p.wsd)} detail={`Gana cuando llega al showdown (${frac(p.wsd)})`} />
        <Stat name="Gana tras ver el flop" value={pct(p.wwsf)} detail={`Cobra algo si ve el flop (${frac(p.wwsf)})`} />
      </div>
      <h2 className="section-title">Resultado real y esperado</h2>
      <div className="card">
        {real.length > 1 ? (
          <SeriesChart title={`Resultado acumulado de ${nameOf(data, p.playerId)}: real y esperado`} points={real}
            lines={[{ id: 'real', name: 'Real', color }, { id: 'esperado', name: 'Esperado según sus cartas en los all-in', color, dashed: true }]} />
        ) : <p className="muted small">Con una sola mano todavía no hay evolución para graficar.</p>}
        <p className="xs muted" style={{ marginTop: 8 }}>La línea punteada reemplaza cada all-in por lo que le correspondía según la probabilidad de ganar.</p>
      </div>
      <h2 className="section-title">Resultado por posición</h2>
      <div className="card">
        <BarList title="Resultado por posición, en ciegas grandes" format={v => `${v > 0 ? '+' : ''}${v.toLocaleString('es-AR')} BB`}
          rows={p.byPosition.map(r => ({ label: r.position, value: r.netBB, hint: `${r.hands} ${r.hands === 1 ? 'mano' : 'manos'}` }))} />
      </div>
    </>
  );
}

function Hands({ data }: { data: ApiSessionAnalysis }) {
  return (
    <div className="card">
      {data.handRows.map(h => (
        <details key={h.id} className="hand-item">
          <summary>
            <strong>Mano #{h.handNo}</strong>
            <span className="hand-cards">{h.board.map(c => <PokerCard key={c} card={c} size="sm" />)}</span>
            <span className="small muted">Pozo {formatMoney(h.pot)} · terminó en {STREET[h.endedOn]}{h.wentToShowdown ? ' · showdown' : ''}</span>
          </summary>
          {h.players.filter(p => !p.pending).map(p => (
            <div key={p.playerId} className="hand-seat">
              <span>{nameOf(data, p.playerId)} <span className="xs muted">{p.position ?? ''}{p.foldedStreet ? ` · se retiró en ${STREET[p.foldedStreet]}` : ''}</span></span>
              <span className="hand-cards">{p.hole.map(c => <PokerCard key={c} card={c} size="sm" />)}</span>
              <Signed amount={p.net} />
            </div>
          ))}
          <p className="log">
            {h.actions.filter(a => a.kind).map((a, i) => (
              <span key={i}>{i > 0 && ' · '}{nameOf(data, a.playerId)} {KIND[a.kind!]}{a.kind === 'call' || a.kind === 'raise' ? ` ${a.amount ?? ''}` : ''}{a.allIn ? ' (all-in)' : ''} <span className="xs">({STREET[a.street!]})</span></span>
            ))}
          </p>
        </details>
      ))}
    </div>
  );
}

function WhatIf({ data }: { data: ApiSessionAnalysis }) {
  const w = data.whatIf;
  const foldsByPlayer = useMemo(() => data.players.map(p => {
    const mine = w.folds.filter(f => f.playerId === p.playerId);
    const wins = mine.filter(f => f.result === 'win');
    const loses = mine.filter(f => f.result === 'lose');
    return {
      id: p.playerId, total: mine.length, wins: wins.length,
      missed: wins.reduce((s, f) => s + f.delta, 0), saved: -loses.reduce((s, f) => s + f.delta, 0),
    };
  }), [data, w.folds]);
  const callsByPlayer = useMemo(() => data.players.map(p => {
    const mine = w.calls.filter(c => c.playerId === p.playerId);
    const lost = mine.filter(c => !c.won);
    const won = mine.filter(c => c.won);
    return {
      id: p.playerId, lost: lost.length, committed: lost.reduce((s, c) => s + c.committed, 0),
      won: won.length, gained: won.reduce((s, c) => s + c.net, 0),
    };
  }), [data, w.calls]);
  const topAllIns = [...w.allIns].sort((a, b) => Math.abs(b.net - b.evNet) - Math.abs(a.net - a.evNet)).slice(0, 6);
  const topFolds = [...w.folds].filter(f => f.result === 'win').sort((a, b) => b.delta - a.delta).slice(0, 5);
  const luckRows = w.luck.filter(l => l.allInHands > 0);
  const cardRows = w.luck.filter(l => l.cardScoreVsTable !== null);

  return (
    <>
      <div className="notice notice-info" role="note">
        Son estimaciones: suponen que el resto de la acción habría sido igual. Muestran las cartas de todos, por eso solo
        están disponibles con la partida cerrada.
      </div>

      <h2 className="section-title">Suerte en los all-in</h2>
      <div className="card">
        {luckRows.length === 0 ? <p className="muted small">No hubo all-in con showdown en esta partida.</p> : (
          <>
            <BarList title="Suerte en los all-in: resultado menos esperado" format={signed} rows={luckRows.map(l => ({ label: nameOf(data, l.playerId), value: l.luck, hint: `${l.allInHands} ${l.allInHands === 1 ? 'mano' : 'manos'}` }))} />
            <p className="xs muted" style={{ marginTop: 8 }}>
              Positivo: cobró más de lo que sus cartas pedían (suerte). Negativo: mala suerte. Es la diferencia entre lo que
              ganó y lo que le correspondía según la probabilidad de ganar cuando quedó todo el dinero adentro.
            </p>
          </>
        )}
        {topAllIns.map(e => (
          <div key={`${e.handNo}-${e.playerId}`} className="hand-seat">
            <span>
              <strong>{nameOf(data, e.playerId)}</strong> · mano #{e.handNo}
              <span className="xs muted"> tenía {Math.round(e.equity * 100)}%{e.equity >= 0.65 && e.net < 0 ? ' · bad beat' : e.equity <= 0.35 && e.net > 0 ? ' · remontó' : ''}</span>
            </span>
            <span className="hand-cards">{e.hole.map(c => <PokerCard key={c} card={c} size="sm" />)}</span>
            <span className="small">
              <Signed amount={e.net} /> <span className="xs muted">(esperado {signed(e.evNet)})</span>
            </span>
          </div>
        ))}
      </div>

      <h2 className="section-title"><Emoji>🙈</Emoji> Y si no te retirabas</h2>
      <div className="card">
        {data.handsWithRunout === 0 ? (
          <p className="muted small">Esta partida no guardó las cartas que no llegaron a salir, así que no se puede calcular.</p>
        ) : (
          <>
            <div className="table-scroll" tabIndex={0} role="group" aria-label="Retiradas por jugador (se desplaza horizontalmente)">
              <table>
                <caption className="sr-only">Retiradas ante una apuesta, según lo que habría pasado</caption>
                <thead><tr><th scope="col">Jugador</th><th scope="col">Retiradas</th><th scope="col">Ganaban</th><th scope="col">Habría cobrado</th><th scope="col">Se ahorró</th></tr></thead>
                <tbody>
                  {foldsByPlayer.map(f => (
                    <tr key={f.id}><th scope="row">{nameOf(data, f.id)}</th><td>{f.total}</td><td>{f.wins}</td><td>{formatMoney(f.missed)}</td><td>{formatMoney(f.saved)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="xs muted" style={{ margin: '8px 0' }}>
              «Ganaban»: retiradas ante una apuesta en las que, con las cartas que después salieron, habrían ganado contra quienes
              siguieron. «Se ahorró»: lo que no puso en las que habrían perdido.
            </p>
            {topFolds.map(f => (
              <div key={`${f.handNo}-${f.playerId}`} className="hand-seat">
                <span><strong>{nameOf(data, f.playerId)}</strong> · mano #{f.handNo}<span className="xs muted"> se retiró en {STREET[f.street]}</span></span>
                <span className="hand-cards">{f.hole.map(c => <PokerCard key={c} card={c} size="sm" />)}</span>
                <span className="small">Habría cobrado <Money amount={f.delta} /></span>
              </div>
            ))}
          </>
        )}
      </div>

      <h2 className="section-title"><Emoji>🪙</Emoji> Y si no pagabas</h2>
      <div className="card">
        {w.calls.length === 0 ? <p className="muted small">No hubo igualadas registradas.</p> : (
          <>
            <div className="table-scroll" tabIndex={0} role="group" aria-label="Igualadas por jugador (se desplaza horizontalmente)">
              <table>
                <caption className="sr-only">Igualadas según cómo terminó la mano</caption>
                <thead><tr><th scope="col">Jugador</th><th scope="col">Perdió pagando</th><th scope="col">Puso desde ahí</th><th scope="col">Ganó pagando</th><th scope="col">Ganó</th></tr></thead>
                <tbody>
                  {callsByPlayer.map(c => (
                    <tr key={c.id}><th scope="row">{nameOf(data, c.id)}</th><td>{c.lost}</td><td>{formatMoney(c.committed)}</td><td>{c.won}</td><td>{formatMoney(c.gained)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="xs muted" style={{ marginTop: 8 }}>
              Se toma la primera igualada de cada mano. «Puso desde ahí»: lo que aportó después de igualar en las manos que
              perdió; es lo que se habría ahorrado retirándose en ese momento.
            </p>
          </>
        )}
      </div>

      <h2 className="section-title"><Emoji>🎴</Emoji> Cartas recibidas</h2>
      <div className="card">
        {cardRows.length === 0 ? <p className="muted small">Sin datos de las cartas recibidas.</p> : (
          <>
            <BarList title="Calidad de las cartas recibidas frente al promedio de la mesa"
              format={v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} pts`}
              rows={cardRows.map(l => ({ label: nameOf(data, l.playerId), value: Math.round((l.cardScoreVsTable ?? 0) * 100), hint: l.vpipRate !== null ? `VPIP ${Math.round(l.vpipRate * 100)}%` : undefined }))} />
            <p className="xs muted" style={{ marginTop: 8 }}>
              Positivo: le tocaron mejores cartas iniciales que al resto. Si su VPIP es alto con cartas flojas, jugó más manos
              de las que las cartas pedían.
            </p>
          </>
        )}
      </div>
    </>
  );
}
