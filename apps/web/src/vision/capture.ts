import type { CardBox, Pt } from './detect';

interface Track {
  id: number;
  center: Pt;
  /** Posiciones de los últimos cuadros, para saber si la carta está quieta. */
  trail: Pt[];
  age: number;
  missed: number;
  box: CardBox;
}

export interface CaptureState {
  /** Cartas nuevas (todavía no enviadas) que ya están quietas. */
  fresh: { id: number; box: CardBox }[];
  /** true cuando hay exactamente las cartas que se esperan y quietas: hay que sacar el recorte. */
  ready: boolean;
  /** Cartas nuevas que se ven, quietas o no (para guiar a quien filma). */
  visible: number;
}

/**
 * Decide cuándo recortar las cartas de un video sin leerlas. Sigue cada carta entre cuadros y, cuando las `expected`
 * cartas nuevas llevan unos cuadros quietas, avisa. Las ya enviadas (`consume`) se ignoran, así el turn y el river
 * esperan solo la carta nueva aunque el flop siga a la vista.
 */
export class CardCapturer {
  private tracks: Track[] = [];
  private nextId = 1;
  private consumed = new Set<number>();
  constructor(
    /** Cuadros seguidos que una carta debe verse quieta. */
    private readonly still = 5,
    /** Desplazamiento máximo (px del cuadro de trabajo) en esa ventana para considerarla quieta. */
    private readonly maxDrift = 6,
    private readonly maxJump = 50,
    private readonly maxMissed = 4,
  ) {}

  update(boxes: CardBox[], expected: number): CaptureState {
    const free = new Set(this.tracks);
    for (const box of boxes) {
      let best: Track | null = null, bd = this.maxJump;
      for (const t of free) {
        const d = Math.hypot(t.center.x - box.center.x, t.center.y - box.center.y);
        if (d < bd) { bd = d; best = t; }
      }
      if (best) {
        free.delete(best);
        best.center = box.center; best.box = box; best.missed = 0; best.age++;
        best.trail.push(box.center);
        if (best.trail.length > this.still) best.trail.shift();
      } else {
        this.tracks.push({ id: this.nextId++, center: box.center, trail: [box.center], age: 1, missed: 0, box });
      }
    }
    for (const t of free) t.missed++;
    this.tracks = this.tracks.filter(t => t.missed <= this.maxMissed);
    const fresh = this.tracks.filter(t => !this.consumed.has(t.id) && t.missed === 0);
    const still = fresh.filter(t => t.age >= this.still && this.drift(t) <= this.maxDrift);
    return {
      fresh: still.sort((a, b) => a.center.x - b.center.x).map(t => ({ id: t.id, box: t.box })),
      ready: expected > 0 && still.length === expected && fresh.length === expected,
      visible: fresh.length,
    };
  }

  /** Marca estas cartas como enviadas: no cuentan para los pasos siguientes. */
  consume(ids: number[]): void { for (const id of ids) this.consumed.add(id); }

  reset(): void { this.tracks = []; this.consumed.clear(); }

  private drift(t: Track): number {
    let m = 0;
    for (const p of t.trail) m = Math.max(m, Math.hypot(p.x - t.center.x, p.y - t.center.y));
    return m;
  }
}
