import type { NotesFile, ResolvedNotes } from '../schema/notes.js';
import { beatTicks, type MeterMap, type TempoMap } from './tempo.js';

// The one place a notes placement becomes sample times (sequencer.md
// §3.5): a part, or a chosen MIDI take, from the tick where it is placed
// through the placing track's maps. The build renders what this returns,
// and a live schedule plays it, so a part plays live where it renders.

export interface NotesTime {
  tempo: TempoMap; // the placing track's, at the track's rate
  // The placing track's, or undefined when its map is broken: a musical
  // time then cannot resolve, and says so.
  meter: MeterMap | undefined;
}

// Where an entry starts, in ticks on its track: an absolute entry's `at`
// is samples, which the tempo map turns into the tick it falls on.
export function placementAnchor(entry: { anchor: 'musical' | 'absolute'; at: number }, tempo: TempoMap): number {
  return entry.anchor === 'absolute' ? tempo.samplesToTicks(entry.at) : entry.at;
}

// The whole tick an entry's window starts on, which a MIDI take's
// `started_at_ticks` counts from: an absolute entry's sample can fall
// between ticks, and a take's start is a whole tick.
export function entryTick(entry: { anchor: 'musical' | 'absolute'; at: number }, tempo: TempoMap): number {
  return Math.round(placementAnchor(entry, tempo));
}

// Where a MIDI take in ticks starts on its track (sequencer.md §2.4):
// `started_at_ticks` after the tick its record entry's window starts
// on, so moving the entry moves the take by the same musical distance.
export function takeAnchor(
  entry: { anchor: 'musical' | 'absolute'; at: number },
  take: { started_at_ticks?: number | undefined },
  tempo: TempoMap,
): number {
  if (take.started_at_ticks === undefined) {
    throw new Error('a take in ticks starts started_at_ticks after its record entry, and this row has none');
  }
  const anchor = entryTick(entry, tempo) + take.started_at_ticks;
  if (anchor < 0) throw new Error(`it starts ${-anchor} ticks before its track does — move the record entry later`);
  return anchor;
}

function musicalMeter(meter: MeterMap | undefined): MeterMap {
  if (meter === undefined) throw new Error('musical time but no valid meter map applies');
  return meter;
}

// A position counts from the file's start: [1] is where it is placed,
// and [2, 3] is beat 3 of its second bar. Bars and beats are the ones in
// force at the moving position, as a musical duration counts them
// (musical-time.md §1.4), so a part placed across a meter change keeps
// its bars whole. The beat and tick ranges are the bar's own.
function positionTicks(value: number | number[], from: number, meter: MeterMap | undefined): number {
  if (!Array.isArray(value)) return from + value;
  const map = musicalMeter(meter);
  const [bar = 1, beat = 1, tick = 1] = value;
  const barStart = from + map.spanTicks(from, [bar - 1]);
  const { numerator, denominator } = map.meterAt(barStart);
  if (beat > numerator) throw new Error(`beat ${beat} out of range for ${numerator}/${denominator} in bar ${bar}`);
  if (tick > beatTicks(denominator)) throw new Error(`tick ${tick} out of range in bar ${bar}`);
  return barStart + map.spanTicks(barStart, [0, beat - 1, tick - 1]);
}

function spanTicks(value: number | number[], from: number, meter: MeterMap | undefined): number {
  return Array.isArray(value) ? musicalMeter(meter).spanTicks(from, value) : value;
}

// Each failure names the row it came from, as the schema's own messages
// do, because the file cannot say it alone: a beat that is in range in
// one placement can be out of range in another.
function at<T>(path: string, resolve: () => T): T {
  try {
    return resolve();
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

// A file in ticks resolves from `anchor` through the track's maps, and
// its times become samples from the anchor's sample. A file with
// `sample_rate:` is already samples from its start, at its own rate.
export function resolveNotes(file: NotesFile, anchor: number, time: NotesTime): ResolvedNotes {
  const inTicks = file.sample_rate === undefined;
  const from = inTicks ? anchor : 0;
  // Rounded once, on the distance from the anchor: rounding the two ticks
  // apart moves a note by a sample with where the part is placed, which
  // gives each placement a render of its own.
  const sample = (t: number): number => (inTicks ? Math.round(time.tempo.secondsBetween(anchor, t) * time.tempo.sampleRate) : t);
  const meter = inTicks ? time.meter : undefined;
  const start = (row: { at: number | number[] }, path: string): number =>
    at(`${path}.at`, () => positionTicks(row.at, from, meter));

  let end = from;
  const notes = file.notes.map((n, i) => {
    const on = start(n, `notes.${i}`);
    const off = on + at(`notes.${i}.length`, () => spanTicks(n.length, on, meter));
    end = Math.max(end, off);
    return { at: sample(on), length: sample(off) - sample(on), note: n.note, velocity: n.velocity, channel: n.channel };
  });
  const controls = file.controls.map((c, i) => ({ at: sample(start(c, `controls.${i}`)), cc: c.cc, value: c.value, channel: c.channel }));
  const bends = file.bends.map((b, i) => ({ at: sample(start(b, `bends.${i}`)), value: b.value, channel: b.channel }));
  const length = file.length === undefined ? end : from + at('length', () => spanTicks(file.length!, from, meter));
  return { sample_rate: file.sample_rate ?? time.tempo.sampleRate, length: sample(length), notes, controls, bends };
}

// How long a file is from where it is placed, in the placing entry's
// own units, ticks for a musical entry and samples for an absolute one:
// what a looping notes entry repeats at when it omits `every`.
export function notesLength(file: NotesFile, entry: { anchor: 'musical' | 'absolute'; at: number }, time: NotesTime): number {
  const anchor = placementAnchor(entry, time.tempo);
  const resolved = resolveNotes(file, anchor, time);
  const seconds = resolved.length / resolved.sample_rate;
  if (entry.anchor === 'absolute') return Math.round(seconds * time.tempo.sampleRate);
  return Math.round(time.tempo.secondsToTicks(time.tempo.ticksToSeconds(anchor) + seconds) - anchor);
}
