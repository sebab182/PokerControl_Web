import type { Pt } from './detect';
import type { Reading } from './classify';

interface Track { id: number; center: Pt; votes: Reading[]; missed: number }
export interface Stable { id: number; card: string; confidence: number; votes: number; center: Pt }

/**
 * Sigue cada carta entre cuadros y la da por leída cuando la misma lectura se repite en la mayoría de los últimos
 * cuadros. Evita que un cuadro borroso cambie la carta.
 */
export class Stabilizer {
  private tracks: Track[] = [];
  private nextId = 1;
  constructor(private readonly window = 8, private readonly need = 5, private readonly maxJump = 90, private readonly maxMissed = 6) {}

  update(items: { center: Pt; reading: Reading }[]): Stable[] {
    const free = new Set(this.tracks);
    for (const it of items) {
      let best: Track | null = null, bd = this.maxJump;
      for (const t of free) {
        const d = Math.hypot(t.center.x - it.center.x, t.center.y - it.center.y);
        if (d < bd) { bd = d; best = t; }
      }
      if (best) { free.delete(best); best.center = it.center; best.missed = 0; best.votes.push(it.reading); if (best.votes.length > this.window) best.votes.shift(); }
      else this.tracks.push({ id: this.nextId++, center: it.center, votes: [it.reading], missed: 0 });
    }
    for (const t of free) t.missed++;
    this.tracks = this.tracks.filter(t => t.missed <= this.maxMissed);
    const out: Stable[] = [];
    for (const t of this.tracks) {
      const tally = new Map<string, { n: number; conf: number }>();
      for (const r of t.votes) { const e = tally.get(r.card) ?? { n: 0, conf: 0 }; e.n++; e.conf += r.confidence; tally.set(r.card, e); }
      let top: [string, { n: number; conf: number }] | null = null;
      for (const e of tally) if (!top || e[1].n > top[1].n) top = e;
      if (top && top[1].n >= this.need) out.push({ id: t.id, card: top[0], confidence: top[1].conf / top[1].n, votes: top[1].n, center: t.center });
    }
    return out;
  }

  reset(): void { this.tracks = []; }
}
