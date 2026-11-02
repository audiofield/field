import { describe, expect, it } from 'vitest';
import { MeterMap, TempoMap } from './tempo.js';
import { PPQ } from '../constants.js';

describe('TempoMap', () => {
  it('converts ticks to seconds at constant tempo', () => {
    const map = new TempoMap([{ at: 0, bpm: 120 }], 48000);
    expect(map.ticksToSeconds(0)).toBe(0);
    expect(map.ticksToSeconds(PPQ)).toBeCloseTo(0.5, 10); // one beat at 120
    expect(map.ticksToSeconds(PPQ * 4)).toBeCloseTo(2, 10);
  });

  it('handles tempo changes', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 120 },
        { at: PPQ * 4, bpm: 60 },
      ],
      48000,
    );
    // 4 beats at 120 (2s) + 4 beats at 60 (4s)
    expect(map.ticksToSeconds(PPQ * 8)).toBeCloseTo(6, 10);
  });

  it('integrates linear ramps in closed form', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 120, ramp: 'linear' },
        { at: PPQ * 4, bpm: 240 },
      ],
      48000,
    );
    // ∫ 60/bpm(b) db over 4 beats, 120→240: 60·4·ln(2)/120 = 2·ln 2
    expect(map.ticksToSeconds(PPQ * 4)).toBeCloseTo(2 * Math.log(2), 10);
  });

  it('round-trips seconds to ticks through ramps and changes', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 90, ramp: 'linear' },
        { at: PPQ * 8, bpm: 140 },
        { at: PPQ * 16, bpm: 121.3 },
      ],
      96000,
    );
    for (const ticks of [0, 1, 480, PPQ * 3, PPQ * 8, PPQ * 12, PPQ * 20]) {
      expect(map.secondsToTicks(map.ticksToSeconds(ticks))).toBeCloseTo(ticks, 6);
    }
  });

  it('converts to samples at the project rate', () => {
    const map = new TempoMap([{ at: 0, bpm: 120 }], 96000);
    expect(map.ticksToSamples(PPQ)).toBe(48000);
  });

  it('measures the seconds between two ticks across changes and ramps', () => {
    const map = new TempoMap(
      [
        { at: 0, bpm: 120 },
        { at: PPQ * 4, bpm: 60, ramp: 'linear' },
        { at: PPQ * 8, bpm: 120 },
      ],
      48000,
    );
    for (const [from, to] of [
      [0, PPQ],
      [PPQ * 2, PPQ * 5],
      [PPQ * 5, PPQ * 7],
      [PPQ * 3, PPQ * 10],
      [PPQ, PPQ],
    ] as const) {
      expect(map.secondsBetween(from, to)).toBeCloseTo(map.ticksToSeconds(to) - map.ticksToSeconds(from), 9);
    }
  });

  it('gives a span in a steady segment the same seconds wherever it starts', () => {
    const map = new TempoMap([{ at: 0, bpm: 96 }], 48000);
    const span = map.secondsBetween(0, 2);
    for (let bar = 1; bar < 256; bar++) {
      expect(map.secondsBetween(bar * 3840, bar * 3840 + 2)).toBe(span);
    }
  });

  it('rejects invalid maps', () => {
    expect(() => new TempoMap([], 48000)).toThrow();
    expect(() => new TempoMap([{ at: 100, bpm: 120 }], 48000)).toThrow('tick 0');
    expect(
      () =>
        new TempoMap(
          [
            { at: 0, bpm: 120 },
            { at: 0, bpm: 100 },
          ],
          48000,
        ),
    ).toThrow('ordered');
  });
});

describe('MeterMap', () => {
  it('formats 1-based bar.beat.tick in 4/4', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(map.format(0)).toBe('1.1.1');
    expect(map.format(PPQ)).toBe('1.2.1');
    expect(map.format(PPQ * 4)).toBe('2.1.1');
    expect(map.format(PPQ * 4 + PPQ + 1)).toBe('2.2.2');
  });

  it('parses positions, defaulting beat and tick to 1', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(map.parse('1.1.1')).toBe(0);
    expect(map.parse('2')).toBe(PPQ * 4);
    expect(map.parse('2.2')).toBe(PPQ * 5);
    expect(map.parse('42.2.1')).toBe(PPQ * 4 * 41 + PPQ);
  });

  it('round-trips through meter changes', () => {
    const map = new MeterMap([
      { at: 0, numerator: 4, denominator: 4 },
      { at: PPQ * 8, numerator: 7, denominator: 8 }, // bar 3 becomes 7/8
    ]);
    expect(map.format(PPQ * 8)).toBe('3.1.1');
    // one 7/8 bar = 7 · 480 ticks
    expect(map.format(PPQ * 8 + 7 * 480)).toBe('4.1.1');
    for (const pos of ['1.1.1', '2.4.480', '3.7.1', '5.2.3']) {
      expect(map.format(map.parse(pos))).toBe(pos);
    }
  });

  it('rejects meter changes off the bar boundary', () => {
    expect(
      () =>
        new MeterMap([
          { at: 0, numerator: 4, denominator: 4 },
          { at: PPQ * 3, numerator: 3, denominator: 4 },
        ]),
    ).toThrow('bar boundary');
  });

  it('rejects out-of-range beats and ticks', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(() => map.parse('1.5.1')).toThrow('out of range');
    expect(() => map.parse('1.1.961')).toThrow('out of range');
    expect(() => map.parse('0.1.1')).toThrow('>= 1');
  });

  it('resolves ordinal positions from array parts, like parse', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(map.positionTicks(1)).toBe(0);
    expect(map.positionTicks(2)).toBe(PPQ * 4);
    expect(map.positionTicks(2, 2)).toBe(PPQ * 5);
    expect(map.positionTicks(42, 2, 1)).toBe(PPQ * 4 * 41 + PPQ);
    expect(() => map.positionTicks(0)).toThrow('>= 1');
    expect(() => map.positionTicks(1, 5)).toThrow('out of range');
  });

  it('advances cardinal spans from an anchor — zero is legal', () => {
    const map = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
    expect(map.spanTicks(0, [4])).toBe(PPQ * 16);
    expect(map.spanTicks(0, [0, 2])).toBe(PPQ * 2);
    expect(map.spanTicks(0, [1, 2, 5])).toBe(PPQ * 6 + 5);
    expect(map.spanTicks(0, [0])).toBe(0);
    // The anchor moves the span, not its length, in constant meter.
    expect(map.spanTicks(PPQ * 7, [2])).toBe(PPQ * 8);
  });

  it('steps spans at the meter in force at the moving position', () => {
    const map = new MeterMap([
      { at: 0, numerator: 4, denominator: 4 },
      { at: PPQ * 8, numerator: 7, denominator: 8 }, // bar 3 becomes 7/8
    ]);
    // Two bars from bar 2: one 4/4 bar, then one 7/8 bar.
    expect(map.spanTicks(PPQ * 4, [2])).toBe(PPQ * 4 + 7 * 480);
    // Beats after the change are eighth-note beats.
    expect(map.spanTicks(PPQ * 8, [0, 2])).toBe(480 * 2);
  });

  it('span() inverts spanTicks from any anchor, through meter changes', () => {
    const map = new MeterMap([
      { at: 0, numerator: 4, denominator: 4 },
      { at: PPQ * 8, numerator: 7, denominator: 8 }, // bar 3 becomes 7/8
    ]);
    expect(map.span(0, PPQ * 8)).toEqual([2, 0, 0]);
    expect(map.span(0, PPQ * 3)).toEqual([0, 3, 0]);
    // Anchored: the same ticks spell differently across the change.
    expect(map.span(PPQ * 8, 480 * 7)).toEqual([1, 0, 0]); // one 7/8 bar
    expect(map.span(PPQ * 4, PPQ * 4 + 480 * 2)).toEqual([1, 2, 0]);
    for (const from of [0, PPQ * 4, PPQ * 8]) {
      for (const t of [0, 1, 479, PPQ, PPQ * 5 + 3, PPQ * 9]) {
        expect(map.spanTicks(from, [...map.span(from, t)])).toBe(t);
      }
    }
  });

  it('position() inverts positionTicks, through meter changes', () => {
    const map = new MeterMap([
      { at: 0, numerator: 4, denominator: 4 },
      { at: PPQ * 8, numerator: 7, denominator: 8 }, // bar 3 becomes 7/8
    ]);
    expect(map.position(0)).toEqual([1, 1, 1]);
    expect(map.position(PPQ * 5)).toEqual([2, 2, 1]);
    expect(map.position(PPQ * 8 + 480 * 3 + 7)).toEqual([3, 4, 8]); // eighth-note beats
    // The inverse property a writer of `at:` arrays leans on: every
    // non-negative tick round-trips exactly.
    for (const t of [0, 1, PPQ - 1, PPQ * 4, PPQ * 8, PPQ * 8 + 479, PPQ * 11 + 3]) {
      expect(map.positionTicks(...map.position(t))).toBe(t);
    }
  });
});
