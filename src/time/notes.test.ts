import { describe, expect, it } from 'vitest';
import { notesFileSchema } from '../schema/notes.js';
import { notesLength, resolveNotes, takeAnchor } from './notes.js';
import { MeterMap, TempoMap } from './tempo.js';

// At 120 bpm and 48 kHz a tick is 25 samples: a quarter note is 960
// ticks and 24000 samples, and a 4/4 bar is 3840 ticks.
const TICK = 25;
const steady = new TempoMap([{ at: 0, bpm: 120 }], 48000);
const fourFour = new MeterMap([{ at: 0, numerator: 4, denominator: 4 }]);
// 4/4 for one bar, then 7/8 from bar 2 on: a 7/8 bar is 3360 ticks.
const toSevenEight = new MeterMap([
  { at: 0, numerator: 4, denominator: 4 },
  { at: 3840, numerator: 7, denominator: 8 },
]);

const part = (rows: object) => notesFileSchema.parse(rows);
const starts = (resolved: { notes: { at: number }[] }): number[] => resolved.notes.map((n) => n.at);

describe('resolving a part', () => {
  const riff = part({
    notes: [
      { at: [1], length: [0, 1], note: 'C3' },
      { at: [2], length: [0, 1], note: 'G3' },
      { at: [3], length: [0, 1], note: 60 },
    ],
  });

  it('starts the part\'s second bar at the bar line after a meter change from 4/4 to 7/8', () => {
    const resolved = resolveNotes(riff, 0, { tempo: steady, meter: toSevenEight });
    expect(starts(resolved)).toEqual([0, 3840 * TICK, (3840 + 3360) * TICK]);
    // From bar 2, every bar of the part is a 7/8 bar.
    expect(starts(resolveNotes(riff, 3840, { tempo: steady, meter: toSevenEight }))).toEqual([0, 3360 * TICK, 2 * 3360 * TICK]);
  });

  it('counts its samples from where it is placed, so one part placed twice in a steady song resolves alike', () => {
    const at1 = resolveNotes(riff, 0, { tempo: steady, meter: fourFour });
    const at17 = resolveNotes(riff, 16 * 3840, { tempo: steady, meter: fourFour });
    expect(at17).toEqual(at1);
    expect(at1).toMatchObject({ sample_rate: 48000, length: 2 * 3840 * TICK + 960 * TICK });
  });

  it.each([133, 128, 96])('resolves alike at every bar of a steady song at %d bpm, where a tick is not a whole number of samples', (bpm) => {
    const tempo = new TempoMap([{ at: 0, bpm }], 48000);
    const time = { tempo, meter: fourFour };
    // One tick of each kind in the bar: 133 bpm never lands on half a
    // sample, and 96 and 128 bpm do, at ticks 2 and 8.
    const ticks = part({ notes: Array.from({ length: 64 }, (_, i) => ({ at: i * 60 + (i % 16), length: 2, note: 60 })) });
    const first = resolveNotes(ticks, 0, time);
    for (let bar = 1; bar < 256; bar++) {
      expect(resolveNotes(ticks, bar * 3840, time)).toEqual(first);
    }
  });

  it('follows the tempo map from where it is placed', () => {
    // 60 bpm from bar 2: a quarter note there is a second.
    const slowing = new TempoMap([{ at: 0, bpm: 120 }, { at: 3840, bpm: 60 }], 48000);
    const resolved = resolveNotes(riff, 0, { tempo: slowing, meter: fourFour });
    expect(starts(resolved)).toEqual([0, 96000, 96000 + 4 * 48000]);
    expect(resolved.notes.map((n) => n.length)).toEqual([24000, 48000, 48000]);
    expect(resolveNotes(riff, 3840, { tempo: slowing, meter: fourFour }).notes[1]!.at).toBe(4 * 48000);
  });

  it('reads beats and ticks within the bar, and scalar times as ticks from the part\'s start', () => {
    const resolved = resolveNotes(
      part({
        length: 1920,
        notes: [
          { at: [1, 3], length: 480, note: 64 },
          { at: [1, 2, 241], length: [0, 0, 120], note: 67, channel: 2 },
          { at: 480, length: 0, note: 36, velocity: 127 },
        ],
        controls: [{ at: [1, 4], cc: 74, value: 64 }],
        bends: [{ at: 960, value: 0 }],
      }),
      3840,
      { tempo: steady, meter: fourFour },
    );
    expect(resolved).toEqual({
      sample_rate: 48000,
      length: 1920 * TICK,
      notes: [
        { at: 1920 * TICK, length: 480 * TICK, note: 64, velocity: 100, channel: undefined },
        { at: 1200 * TICK, length: 120 * TICK, note: 67, velocity: 100, channel: 2 },
        { at: 480 * TICK, length: 0, note: 36, velocity: 127, channel: undefined },
      ],
      controls: [{ at: 2880 * TICK, cc: 74, value: 64, channel: undefined }],
      bends: [{ at: 960 * TICK, value: 0, channel: undefined }],
    });
  });

  it('ends where its last note ends when it declares no length', () => {
    const resolved = resolveNotes(part({ notes: [{ at: [2, 4], length: [0, 1], note: 60 }, { at: 0, length: 480, note: 62 }] }), 0, {
      tempo: steady,
      meter: fourFour,
    });
    expect(resolved.length).toBe(2 * 3840 * TICK);
    expect(resolveNotes(part({}), 0, { tempo: steady, meter: fourFour }).length).toBe(0);
  });

  it('names the row whose position the placement\'s meter does not have', () => {
    const fifth = part({ notes: [{ at: 0, length: 1, note: 60 }, { at: [2, 5], length: 1, note: 60 }] });
    expect(() => resolveNotes(fifth, 0, { tempo: steady, meter: fourFour })).toThrow('notes.1.at: beat 5 out of range for 4/4 in bar 2');
    // Beat 5 is in range where bar 2 is a 7/8 bar.
    expect(() => resolveNotes(fifth, 0, { tempo: steady, meter: toSevenEight })).not.toThrow();
    expect(() => resolveNotes(fifth, 0, { tempo: steady, meter: undefined })).toThrow(
      'notes.1.at: musical time but no valid meter map applies',
    );
  });

  it('plays a take timed in samples as it was recorded, wherever it is placed', () => {
    const take = part({ sample_rate: 44100, length: 44100, notes: [{ at: 4410, length: 22050, note: 60, velocity: 90 }] });
    const resolved = resolveNotes(take, 3840, { tempo: steady, meter: fourFour });
    expect(resolved).toMatchObject({ sample_rate: 44100, length: 44100, notes: [{ at: 4410, length: 22050, note: 60 }] });
  });
});

describe('how long a part is where it is placed', () => {
  const twoBars = part({ length: [2], notes: [] });

  it('counts ticks for a musical entry, through the meter from the entry', () => {
    expect(notesLength(twoBars, { anchor: 'musical', at: 0 }, { tempo: steady, meter: fourFour })).toBe(7680);
    expect(notesLength(twoBars, { anchor: 'musical', at: 0 }, { tempo: steady, meter: toSevenEight })).toBe(3840 + 3360);
  });

  it('counts samples for an absolute entry', () => {
    expect(notesLength(twoBars, { anchor: 'absolute', at: 0 }, { tempo: steady, meter: fourFour })).toBe(7680 * TICK);
  });
});

describe('where a take in ticks starts', () => {
  it('is started_at_ticks after the whole tick its record entry starts on', () => {
    expect(takeAnchor({ anchor: 'musical', at: 3840 }, { started_at_ticks: 1920 }, steady)).toBe(3840 + 1920);
    // 1.5 ticks in samples falls between ticks; the take counts from the whole one.
    expect(takeAnchor({ anchor: 'absolute', at: 1.5 * TICK }, { started_at_ticks: 960 }, steady)).toBe(2 + 960);
    expect(() => takeAnchor({ anchor: 'musical', at: 0 }, {}, steady)).toThrow(
      'a take in ticks starts started_at_ticks after its record entry, and this row has none',
    );
    expect(() => takeAnchor({ anchor: 'musical', at: 0 }, { started_at_ticks: -960 }, steady)).toThrow(
      'it starts 960 ticks before its track does — move the record entry later',
    );
  });
});
