import { PPQ, WHOLE_NOTE_TICKS } from '../constants.js';

// The tempo map is the single source of truth for ticks ↔ seconds; the
// project sample rate maps seconds ↔ samples (project-core.md §3.1).

export interface TempoEvent {
  at: number; // ticks
  bpm: number;
  // 'linear': bpm ramps linearly in beats from this event's bpm to the next
  // event's bpm across the span. The last event's ramp is meaningless.
  ramp?: 'linear' | undefined;
}

export interface MeterEvent {
  at: number; // ticks; must fall on a bar boundary of the preceding meter
  numerator: number;
  denominator: number;
}

export function beatTicks(denominator: number): number {
  return WHOLE_NOTE_TICKS / denominator;
}

export function barTicks(meter: MeterEvent): number {
  return meter.numerator * beatTicks(meter.denominator);
}

export class TempoMap {
  constructor(
    readonly events: TempoEvent[],
    readonly sampleRate: number,
  ) {
    if (events.length === 0) throw new Error('tempo map needs at least one event');
    if (events[0]!.at !== 0) throw new Error('first tempo event must be at tick 0');
    for (let i = 1; i < events.length; i++) {
      if (events[i]!.at <= events[i - 1]!.at) {
        throw new Error('tempo events must be strictly ordered by tick');
      }
    }
  }

  // Seconds from song start at a tick position. Constant segments are
  // trivial; linear ramps integrate 60/bpm(b) db in closed form.
  ticksToSeconds(ticks: number): number {
    if (ticks < 0) throw new Error('negative tick');
    let seconds = 0;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      const next = this.events[i + 1];
      const endTicks = next ? Math.min(next.at, ticks) : ticks;
      if (endTicks > e.at) {
        seconds += this.segmentSeconds(i, endTicks - e.at);
      }
      if (!next || ticks <= next.at) break;
    }
    return seconds;
  }

  // Seconds from one tick to a later one, adding only the segments between
  // them. A span in a steady segment then lasts exactly the same wherever
  // it starts, which subtracting two ticksToSeconds does not promise: each
  // keeps its own rounding error, enough to move a span that falls on half
  // a sample.
  secondsBetween(from: number, to: number): number {
    if (from < 0 || to < from) throw new Error(`no span from tick ${from} to tick ${to}`);
    let seconds = 0;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      const next = this.events[i + 1];
      const start = Math.max(from, e.at);
      const end = next ? Math.min(to, next.at) : to;
      if (end > start) {
        seconds += this.isSteady(i)
          ? this.segmentSeconds(i, end - start)
          : this.segmentSeconds(i, end - e.at) - this.segmentSeconds(i, start - e.at);
      }
    }
    return seconds;
  }

  secondsToTicks(seconds: number): number {
    if (seconds < 0) throw new Error('negative seconds');
    let remaining = seconds;
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]!;
      const next = this.events[i + 1];
      const spanTicks = next ? next.at - e.at : Infinity;
      const spanSeconds = next ? this.segmentSeconds(i, spanTicks) : Infinity;
      if (remaining <= spanSeconds || !next) {
        return e.at + this.segmentTicksAt(i, remaining);
      }
      remaining -= spanSeconds;
    }
    throw new Error('unreachable');
  }

  ticksToSamples(ticks: number): number {
    return Math.round(this.ticksToSeconds(ticks) * this.sampleRate);
  }

  samplesToTicks(samples: number): number {
    return this.secondsToTicks(samples / this.sampleRate);
  }

  private isSteady(i: number): boolean {
    const e = this.events[i]!;
    const next = this.events[i + 1];
    return e.ramp !== 'linear' || !next || next.bpm === e.bpm;
  }

  // Seconds spanned by the first `ticks` ticks of segment i.
  private segmentSeconds(i: number, ticks: number): number {
    const e = this.events[i]!;
    const beats = ticks / PPQ;
    if (this.isSteady(i)) {
      return (beats * 60) / e.bpm;
    }
    const next = this.events[i + 1]!;
    // bpm(b) = b0 + k·b over the full span of B beats, k = (b1 − b0) / B.
    const spanBeats = (next.at - e.at) / PPQ;
    const k = (next.bpm - e.bpm) / spanBeats;
    return (60 / k) * Math.log((e.bpm + k * beats) / e.bpm);
  }

  // Inverse of segmentSeconds: ticks into segment i after `seconds`.
  private segmentTicksAt(i: number, seconds: number): number {
    const e = this.events[i]!;
    if (this.isSteady(i)) {
      return (seconds * e.bpm * PPQ) / 60;
    }
    const next = this.events[i + 1]!;
    const spanBeats = (next.at - e.at) / PPQ;
    const k = (next.bpm - e.bpm) / spanBeats;
    const beats = (e.bpm / k) * (Math.exp((seconds * k) / 60) - 1);
    return beats * PPQ;
  }
}

// Projection between ticks and 1-based bar.beat.tick display positions
// ("42.2.1" = bar 42, beat 2, first tick of that beat).
export class MeterMap {
  constructor(readonly events: MeterEvent[]) {
    if (events.length === 0) throw new Error('meter map needs at least one event');
    if (events[0]!.at !== 0) throw new Error('first meter event must be at tick 0');
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const e = events[i]!;
      if (e.at <= prev.at) throw new Error('meter events must be strictly ordered by tick');
      if ((e.at - prev.at) % barTicks(prev) !== 0) {
        throw new Error(`meter change at tick ${e.at} is not on a bar boundary`);
      }
    }
  }

  // First bar number (1-based) of each meter segment.
  private segmentStartBar(i: number): number {
    let bar = 1;
    for (let s = 1; s <= i; s++) {
      const prev = this.events[s - 1]!;
      bar += (this.events[s]!.at - prev.at) / barTicks(prev);
    }
    return bar;
  }

  private segmentFor(ticks: number): number {
    let i = 0;
    while (i + 1 < this.events.length && this.events[i + 1]!.at <= ticks) i++;
    return i;
  }

  meterAt(ticks: number): MeterEvent {
    return this.events[this.segmentFor(ticks)]!;
  }

  // The ordinal position of a tick — [bar, beat, tick], 1-indexed — as
  // numbers, for a writer that needs the array spelling rather than the
  // display string. positionTicks's inverse: for any non-negative
  // integer T, positionTicks(...position(T)) === T.
  position(ticks: number): [number, number, number] {
    if (ticks < 0 || !Number.isInteger(ticks)) throw new Error(`invalid tick ${ticks}`);
    const i = this.segmentFor(ticks);
    const meter = this.events[i]!;
    const rel = ticks - meter.at;
    const bar = this.segmentStartBar(i) + Math.floor(rel / barTicks(meter));
    const inBar = rel % barTicks(meter);
    const beat = Math.floor(inBar / beatTicks(meter.denominator)) + 1;
    const tick = (inBar % beatTicks(meter.denominator)) + 1;
    return [bar, beat, tick];
  }

  format(ticks: number): string {
    const [bar, beat, tick] = this.position(ticks);
    return `${bar}.${beat}.${tick}`;
  }

  // Ordinal musical position → ticks: bar[, beat[, tick]], 1-indexed —
  // where a musician points (musical-time.md §1.3). There is no bar 0;
  // beat and tick ranges come from the meter in force at that bar.
  positionTicks(bar: number, beat = 1, tick = 1): number {
    if (bar < 1) throw new Error(`bar must be >= 1`);
    let i = 0;
    while (i + 1 < this.events.length && this.segmentStartBar(i + 1) <= bar) i++;
    const meter = this.events[i]!;
    if (beat < 1 || beat > meter.numerator) {
      throw new Error(`beat ${beat} out of range for ${meter.numerator}/${meter.denominator} at bar ${bar}`);
    }
    if (tick < 1 || tick > beatTicks(meter.denominator)) {
      throw new Error(`tick ${tick} out of range at bar ${bar}`);
    }
    return (
      meter.at +
      (bar - this.segmentStartBar(i)) * barTicks(meter) +
      (beat - 1) * beatTicks(meter.denominator) +
      (tick - 1)
    );
  }

  // Tick count → cardinal span from an anchor — spanTicks's inverse,
  // and anchored for the same reason spanTicks is: a meter change
  // inside the span changes what a bar is worth, so the same tick
  // count spells differently from different starting points. Greedy —
  // whole bars, then whole beats, then ticks — which walks exactly the
  // steps spanTicks adds back: spanTicks(from, ...span(from, T)) === T
  // for every non-negative integer T.
  span(from: number, ticks: number): [number, number, number] {
    if (ticks < 0 || !Number.isInteger(ticks)) throw new Error(`invalid span ${ticks}`);
    let at = from;
    let remaining = ticks;
    let bars = 0;
    let beats = 0;
    for (;;) {
      const bar = barTicks(this.events[this.segmentFor(at)]!);
      if (remaining < bar) break;
      remaining -= bar;
      at += bar;
      bars++;
    }
    for (;;) {
      const beat = beatTicks(this.events[this.segmentFor(at)]!.denominator);
      if (remaining < beat) break;
      remaining -= beat;
      at += beat;
      beats++;
    }
    return [bars, beats, remaining];
  }

  // Cardinal span → tick count from an anchor: [bars, beats?, ticks?],
  // zero-legal ([0, 2] is two beats). Bars and beats step at the meter in
  // force at the moving position, so a span crossing a meter change means
  // what a musician means by it (musical-time.md §1.4).
  spanTicks(from: number, span: number[]): number {
    const [bars = 0, beats = 0, ticks = 0] = span;
    let at = from;
    for (let i = 0; i < bars; i++) at += barTicks(this.events[this.segmentFor(at)]!);
    for (let i = 0; i < beats; i++) at += beatTicks(this.events[this.segmentFor(at)]!.denominator);
    return at + ticks - from;
  }

  parse(position: string): number {
    const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(position.trim());
    if (!m) throw new Error(`invalid position "${position}" (expected bar[.beat[.tick]])`);
    try {
      return this.positionTicks(
        Number(m[1]),
        m[2] === undefined ? 1 : Number(m[2]),
        m[3] === undefined ? 1 : Number(m[3]),
      );
    } catch (err) {
      throw new Error(`${(err as Error).message} in "${position}"`);
    }
  }
}
