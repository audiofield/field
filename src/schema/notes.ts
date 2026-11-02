import { z } from 'zod';
import { stringifyCanonical, type KeyOrder } from '../yaml/emit.js';
import { timeLength, timePosition } from './common.js';

// A notes file (sequencer.md §2.2): notes, controller changes, and bends,
// one row each. A part is one you write, under songs/<song>/notes/; a
// MIDI take is one `field record` writes, in scalar ticks from the take's
// start (§2.4). Time fields take musical time's two spellings, a scalar
// in ticks or a musical array, both counted from the file's start and
// resolved through the placing track's meter map (src/time/notes.ts).
// A file with `sample_rate:` is a take recorded before takes landed in
// ticks: its times are samples at that rate, and it plays as recorded.

const channel = z.number().int().min(1).max(16).optional();
const seven = z.number().int().min(0).max(127);

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Scientific pitch, where C4 is 60, as `field keys` prints a note
// (src/keys/print.ts), with a sharp or a flat: C#4 and Db4 are both 61.
export function noteNumber(name: string): number | undefined {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (m === null) return undefined;
  const number = (Number(m[3]) + 1) * 12 + SEMITONES[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return number >= 0 && number <= 127 ? number : undefined;
}

const NOTE_SPELLING = 'a note is a MIDI number from 0 to 127 or a name in scientific pitch, where C4 is 60';
const note = z.unknown().transform((value, ctx) => {
  const number = typeof value === 'string' ? noteNumber(value) : value;
  if (typeof number === 'number' && Number.isInteger(number) && number >= 0 && number <= 127) return number;
  ctx.addIssue({
    code: 'custom',
    message: typeof value === 'string' ? `"${value}" is not a note name: ${NOTE_SPELLING}` : NOTE_SPELLING,
  });
  return z.NEVER;
});

const LISTS = ['notes', 'controls', 'bends'] as const;

export const notesFileSchema = z
  .strictObject({
    sample_rate: z.number().int().positive().optional(),
    // Omitted, the file ends where its last note ends.
    length: timeLength.optional(),
    notes: z
      .array(
        z.strictObject({
          at: timePosition,
          length: timeLength,
          note,
          velocity: z.number().int().min(1).max(127).default(100),
          channel,
        }),
      )
      .default([]),
    controls: z.array(z.strictObject({ at: timePosition, cc: seven, value: seven, channel })).default([]),
    bends: z.array(z.strictObject({ at: timePosition, value: z.number().int().min(0).max(16383), channel })).default([]),
  })
  .superRefine((file, ctx) => {
    if (file.sample_rate === undefined) return;
    const message = 'a notes file with sample_rate: counts samples, so its times are scalars';
    if (Array.isArray(file.length)) ctx.addIssue({ code: 'custom', path: ['length'], message });
    for (const list of LISTS) {
      file[list].forEach((row, i) => {
        for (const [field, value] of Object.entries(row)) {
          if (Array.isArray(value)) ctx.addIssue({ code: 'custom', path: [list, i, field], message });
        }
      });
    }
  });
export type NotesFile = z.infer<typeof notesFileSchema>;

// One row per note, each on one line however many fields it spells, so
// two versions of a part diff line by line. `field fmt` keeps the
// spelling each row has: a name or a number, ticks or musical time.
const row = (keys: string[]): KeyOrder => ({ keys, flow: true });
export const notesFileOrder: KeyOrder = {
  keys: ['sample_rate', 'length', ...LISTS],
  lineWidth: 0,
  children: {
    length: { flow: true },
    notes: { items: row(['at', 'length', 'note', 'velocity', 'channel']) },
    controls: { items: row(['at', 'cc', 'value', 'channel']) },
    bends: { items: row(['at', 'value', 'channel']) },
  },
};

// Notes with every time a scalar in one unit and every note a number:
// what pairing captured messages makes, and a take's ticks.
export interface TimedNotes {
  length: number;
  notes: { at: number; length: number; note: number; velocity: number; channel?: number | undefined }[];
  controls: { at: number; cc: number; value: number; channel?: number | undefined }[];
  bends: { at: number; value: number; channel?: number | undefined }[];
}

// A notes file resolved for one placement: every time in samples at
// `sample_rate`, from where the placement starts. The render plays it.
export interface ResolvedNotes extends TimedNotes {
  sample_rate: number;
}

// What the daemon captures: one MIDI message, `at` samples into the take.
export interface CapturedMessage {
  at: number;
  midi: number[];
}

// Pairs each note-on with the note-off that ends it, in the messages'
// own time unit. A note still held at the end lasts to the end; a
// note-off whose note-on came before the take began is dropped; a second
// note-on for a sounding note ends the first.
export function notesFromMessages(messages: readonly CapturedMessage[], length: number): TimedNotes {
  const notes: TimedNotes['notes'] = [];
  const controls: TimedNotes['controls'] = [];
  const bends: TimedNotes['bends'] = [];
  const open = new Map<number, { at: number; velocity: number }>();
  const withChannel = <T extends object>(row: T, ch: number): T & { channel?: number } =>
    ch === 1 ? row : { ...row, channel: ch };
  const end = (key: number, at: number): void => {
    const on = open.get(key);
    if (on === undefined) return;
    open.delete(key);
    notes.push(withChannel({ at: on.at, length: Math.max(0, at - on.at), note: key % 128, velocity: on.velocity }, Math.floor(key / 128)));
  };

  for (const { at, midi } of messages) {
    const [status = 0, data1 = 0, data2 = 0] = midi;
    const ch = (status & 0x0f) + 1;
    const kind = status & 0xf0;
    const key = ch * 128 + data1;
    if (kind === 0x90 && data2 > 0) {
      end(key, at);
      open.set(key, { at, velocity: data2 });
    } else if (kind === 0x80 || kind === 0x90) {
      end(key, at);
    } else if (kind === 0xb0) {
      controls.push(withChannel({ at, cc: data1, value: data2 }, ch));
    } else if (kind === 0xe0) {
      bends.push(withChannel({ at, value: data1 | (data2 << 7) }, ch));
    }
  }
  for (const key of [...open.keys()]) end(key, length);

  notes.sort((a, b) => a.at - b.at || a.note - b.note || (a.channel ?? 1) - (b.channel ?? 1));
  return { length, notes, controls, bends };
}

// A take's bytes, in ticks: what the ledger pins. They are canonical as
// a part, so a take copied into songs/<song>/notes/ is a part `field fmt`
// leaves alone, with the take's hash.
export function formatNotesFile(file: TimedNotes): string {
  return stringifyCanonical(file, notesFileOrder);
}

// The renderer's input (sc/voice-render.scd): every event in time order,
// in seconds, with 0-based MIDI channels. At one instant, note-offs come
// first, then controller changes and bends, then note-ons, so a note
// played again at the moment it ends is a new voice, and a pedal pressed
// at a note's onset already holds it. A note that ends where it starts,
// as a drum pad's on and off can inside one sample, releases right after
// its own on: ranked with the other offs it would come first, and nothing
// would ever release the voice.
export type RenderEvent =
  | [number, 'on', number, number, number]
  | [number, 'off', number, number]
  | [number, 'cc', number, number, number]
  | [number, 'bend', number, number];

export function renderEvents(file: ResolvedNotes): RenderEvent[] {
  const seconds = (samples: number): number => samples / file.sample_rate;
  const [OFF, CONTROL, ON] = [0, 1, 2];
  const timed: { at: number; rank: number; event: RenderEvent }[] = [];
  for (const n of file.notes) {
    const ch = (n.channel ?? 1) - 1;
    timed.push({ at: n.at, rank: ON, event: [seconds(n.at), 'on', ch, n.note, n.velocity] });
    timed.push({ at: n.at + n.length, rank: n.length === 0 ? ON : OFF, event: [seconds(n.at + n.length), 'off', ch, n.note] });
  }
  for (const c of file.controls) {
    timed.push({ at: c.at, rank: CONTROL, event: [seconds(c.at), 'cc', (c.channel ?? 1) - 1, c.cc, c.value] });
  }
  for (const b of file.bends) timed.push({ at: b.at, rank: CONTROL, event: [seconds(b.at), 'bend', (b.channel ?? 1) - 1, b.value] });
  return timed
    .map((t, index) => ({ ...t, index }))
    .sort((a, b) => a.at - b.at || a.rank - b.rank || a.index - b.index)
    .map((t) => t.event);
}
